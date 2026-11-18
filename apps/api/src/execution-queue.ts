import type { ExecutionRecord, ExecutionStore, RetryPolicy } from "@4evergent/database";
import { computeNextRetryAt, DEFAULT_RETRY_POLICY } from "@4evergent/database";

export interface ExecutionResult {
  record: ExecutionRecord;
  success: boolean;
  status: string;
  error?: string;
  errorClass?: string;
  txHash?: string;
  submittedHash?: string | null;
  /** ActivityRecord id updated by the pipeline for schedule-driven executions. */
  activityId?: string;
}

export type PreCheckResult = "found" | "not_found" | "network_error";

export type PreCheckFn = (txHash: string) => Promise<PreCheckResult>;

export interface ExecutionContext {
  signal: AbortSignal;
  onBeforeSubmit?: () => void | Promise<void>;
  onSubmitted?: (txHash?: string) => void | Promise<void>;
}

export type PipelineExecutor = (
  record: ExecutionRecord,
  context?: ExecutionContext
) => Promise<ExecutionResult>;

export type SourceAccountProvider = () => Promise<{
  accountId: () => string;
  sequenceNumber: () => string;
  incrementSequenceNumber: () => void;
}>;

/**
 * ExecutionQueue — processes due ExecutionRecords in bounded-concurrency
 * batches. Each execution is run through the provided pipeline executor (which
 * for this project points to TransactionPipeline.execute()).
 *
 * Responsibilities:
 *   - poll ExecutionStore for due records
 *   - mark record as "executing"
 *   - invoke pipeline executor
 *   - transition record to terminal state (submitted / confirmed / failed /
 *     dead_letter) or schedule a retry with backoff
 *   - provide an onBeforeExecute hook for duplicate /
 *     re-entrancy guarding
 */
export class ExecutionQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private clock: () => Date;
  private intervalMs: number;
  private concurrency: number;
  private activeCount = 0;
  private retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;
  private nowFn: () => Date = () => new Date();
  private preCheck?: PreCheckFn;
  private inFlight = new Map<
    string,
    {
      controller: AbortController;
      phase: "running" | "submitting" | "submitted";
    }
  >();

  constructor(
    private store: ExecutionStore,
    private pipelineExecutor: PipelineExecutor,
    private getSourceAccount: SourceAccountProvider,
    private options: ExecutionQueueOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 10_000;
    this.concurrency = options.concurrency ?? 1;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.nowFn = options.now ?? (() => new Date());
    this.preCheck = options.preCheck;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Drain in-flight executions, resolving when activeCount reaches 0
   * or when timeoutMs (if specified) has elapsed.
   */
  async drain(timeoutMs?: number): Promise<void> {
    if (this.activeCount === 0) return;
    const start = Date.now();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let checkInterval: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (checkInterval) clearInterval(checkInterval);
        resolve();
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(cleanup, timeoutMs);
      }

      checkInterval = setInterval(() => {
        if (this.activeCount === 0) {
          cleanup();
        } else if (timeoutMs !== undefined && Date.now() - start >= timeoutMs) {
          cleanup();
        }
      }, 20);
    });
  }

  /**
   * Abort in-flight executions that are in the "running" phase.
   * Executions in "submitting" or "submitted" are not aborted to avoid
   * ambiguous state on the network wire.
   */
  abortInFlight(): void {
    for (const inFlightState of this.inFlight.values()) {
      if (inFlightState.phase === "running") {
        inFlightState.controller.abort();
      }
    }
  }

  /**
   * Manually enqueue a new execution record.
   */
  async enqueue(record: ExecutionRecord): Promise<ExecutionRecord> {
    await this.store.record(record);
    return record;
  }

  /**
   * Process due executions.
   *
   * Called by tick(), but can also be invoked directly (for testing or
   * external triggers). Returns number of executions started.
   */
  async processDue(nowIso?: string): Promise<number> {
    const now = nowIso ?? this.clock().toISOString();
    const due = await this.store.listDue(now, 50);
    let started = 0;

    for (const record of due) {
      if (this.activeCount >= this.concurrency) break;
      // Duplicate safety: skip if already executing (e.g., another worker
      // picked it up between listDue and our claim).
      if (record.status === "executing") continue;

      const claimed = await this.runExecution(record);
      if (claimed) started++;
    }

    return started;
  }

  /**
   * Manual retry — transitions failed/dead_letter back to queued.
   * Cancelled executions cannot be retried.
   * Uses atomic conditional update to prevent race with worker.
   * Includes pre-check guard against ambiguous submission.
   */
  async retry(id: string, maxRetries: number): Promise<{ status: string; execution?: ExecutionRecord }> {
    const existing = await this.store.get(id);
    if (!existing) return { status: "not_found" };
    if (existing.status !== "failed" && existing.status !== "dead_letter") {
      return { status: "invalid_state" };
    }
    if (existing.attempt >= maxRetries) {
      return { status: "max_retries_reached" };
    }

    // Pre-check guard: if there's a submitted hash and a pre-check function, verify
    // transaction status before allowing retry (prevents blind resubmission)
    if (existing.submittedHash && this.preCheck) {
      const preCheckResult = await this.preCheck(existing.submittedHash);
      if (preCheckResult === "found") {
        // Transaction exists on-chain — do not retry, move to submitted for reconciliation
        await this.store.updateIfStatus(id, existing.status, {
          status: "submitted",
          txHash: existing.submittedHash,
          error: null,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const updatedRecord = await this.store.get(id);
        return { status: "submitted", execution: updatedRecord ?? undefined };
      }
      if (preCheckResult === "network_error") {
        // Ambiguous — do not blind retry, preserve state
        return { status: "ambiguous_submission", execution: existing };
      }
      // not_found — fall through to normal retry
    }

    const now = new Date().toISOString();
    // #378: a re-queued record is a FRESH attempt — the previous attempt's
    // hashes must not travel with it, or listDue would treat a later
    // queue-failure as a terminal on-chain outcome (failed + submittedHash
    // is never picked up) and the operator's retry could never auto-retry.
    // The pre-check above already ran against the old hash, so clearing
    // here does not weaken its guard.
    const updated = await this.store.updateIfStatus(id, existing.status, {
      status: "queued",
      nextRetryAt: null,
      error: null,
      txHash: null,
      submittedHash: null,
      startedAt: null,
      updatedAt: now,
    });
    if (!updated) return { status: "conflict" };
    return { status: "queued", execution: updated };
  }

  /**
   * Manual cancellation — transitions queued/executing to cancelled.
   * Uses atomic conditional update to prevent race with worker.
   *
   * Supported Worker Model:
   * - "queued": Can be safely cancelled before execution starts. An atomic
   *   conditional update transitions it to "cancelled", ensuring no worker
   *   can claim it.
   * - "executing": Can ONLY be cancelled by the specific ExecutionQueue instance
   *   currently executing it (holding the active inFlight controller). In a
   *   multi-instance deployment or if no local in-flight entry exists,
   *   cancellation is rejected ("invalid_state" with reason "not_in_flight")
   *   because this instance cannot abort the remote worker's pipeline, and
   *   marking it cancelled would falsely imply transaction submission was
   *   prevented.
   * - "submitting" / "submitted": Once an in-flight execution enters the
   *   transaction submission phase, cancellation is rejected ("invalid_state"
   *   with reason "submitting").
   */
  async cancel(
    id: string
  ): Promise<{ status: string; reason?: string; execution?: ExecutionRecord }> {
    const existing = await this.store.get(id);
    if (!existing) return { status: "not_found" };
    if (existing.status !== "queued" && existing.status !== "executing") {
      return { status: "invalid_state" };
    }

    if (existing.status === "executing") {
      const inFlightRun = this.inFlight.get(id);
      if (!inFlightRun) {
        return { status: "invalid_state", reason: "not_in_flight" };
      }
      if (inFlightRun.phase === "submitting" || inFlightRun.phase === "submitted") {
        return { status: "invalid_state", reason: "submitting" };
      }
      inFlightRun.controller.abort();
    }

    const now = new Date().toISOString();
    const updated = await this.store.updateIfStatus(id, existing.status, {
      status: "cancelled",
      nextRetryAt: null,
      startedAt: null,
      completedAt: now,
      error: "cancelled by user",
      updatedAt: now,
    });
    if (!updated) return { status: "conflict" };
    return { status: "cancelled", execution: updated };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.processDue();
    } catch (err) {
      console.error("[execution-queue] tick error:", err);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
  }

  private async runExecution(record: ExecutionRecord): Promise<boolean> {
    const claimed = await this.claim(record);
    if (!claimed) return false;
    this.activeCount++;

    const controller = new AbortController();
    const inFlightState: {
      controller: AbortController;
      phase: "running" | "submitting" | "submitted";
    } = {
      controller,
      phase: "running",
    };
    this.inFlight.set(record.id, inFlightState);

    const context: ExecutionContext = {
      signal: controller.signal,
      onBeforeSubmit: () => {
        if (controller.signal.aborted) {
          const err = new Error("Execution was cancelled");
          err.name = "AbortError";
          throw err;
        }
        inFlightState.phase = "submitting";
      },
      onSubmitted: (_txHash) => {
        inFlightState.phase = "submitted";
      },
    };

    try {
      const result = await this.runPipeline(record, context);
      if (controller.signal.aborted) {
        return true;
      }
      await this.complete(record, result);
      return true;
    } catch (err) {
      if (controller.signal.aborted) {
        return true;
      }
      // Classify the error (transient vs permanent) for retry decision
      const errorClass = classifyUncaughtError(err);
      await this.fail(record, err, errorClass);
      return true;
    } finally {
      this.inFlight.delete(record.id);
      this.activeCount--;
    }
  }

  /**
   * Atomically claim a due record (queued or failed) → executing.
   * Uses conditional update against the observed status so a concurrent
   * worker that already claimed the same id loses the race and skips.
   */
  private async claim(record: ExecutionRecord): Promise<boolean> {
    if (record.status !== "queued" && record.status !== "failed") return false;
    const now = new Date().toISOString();
    const updated = await this.store.updateIfStatus(record.id, record.status, {
      status: "executing",
      startedAt: now,
      updatedAt: now,
    });
    return updated !== null;
  }

  private async runPipeline(record: ExecutionRecord, context?: ExecutionContext): Promise<ExecutionResult> {
    // The actual pipeline executor is injected (to avoid direct imports
    // of @4evergent/stellar). For the API server, this is
    // TransactionPipeline.execute() wrapped in a source-account provider.
    return this.pipelineExecutor(record, context);
  }

  private async complete(record: ExecutionRecord, result: ExecutionResult): Promise<void> {
    const update: Record<string, unknown> = {
      status: result.status as ExecutionRecord["status"],
      txHash: result.txHash ?? null,
      submittedHash: result.submittedHash ?? record.submittedHash ?? null,
      error: null,
      // #378: a successful submission clears the stale retry schedule (and
      // the previous attempt's error classification). Without this, a
      // record that later fails on-chain keeps an already-past nextRetryAt
      // and the queue would re-execute the terminal outcome.
      nextRetryAt: null,
      errorClass: null,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (result.activityId) {
      update.activityId = result.activityId;
    }
    if (result.success) {
      await this.store.updateIfStatus(record.id, "executing", update as Partial<ExecutionRecord>);
    } else {
      await this.fail(record, result.error ?? new Error("Unknown error"), result.errorClass as "transient" | "permanent" | undefined, update);
    }
  }

  private async fail(
    record: ExecutionRecord,
    error: unknown,
    errorClass?: "transient" | "permanent",
    extraUpdate?: Record<string, unknown>
  ): Promise<void> {
    const current = await this.store.get(record.id);
    if (!current || current.status !== "executing") {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const classification = errorClass ?? classifyUncaughtError(error);
    const attempt = record.attempt + 1;

    // Update attempt count on the record
    await this.store.updateIfStatus(record.id, "executing", {
      attempt,
      error: message,
      errorClass: classification,
      updatedAt: new Date().toISOString(),
      ...(extraUpdate?.activityId ? { activityId: extraUpdate.activityId } : {}),
    } as Partial<ExecutionRecord>);

    // Decide whether to retry or move to dead_letter
    // Use pre-check enhanced decision if preCheck is available and a hash
    // exists for the CURRENT attempt (see below).
    let shouldRetry = false;
    let nextRetryAt: string | null = null;

    // #378: the pre-check must consult the CURRENT attempt's hash — the
    // outcome's submittedHash (carried in extraUpdate by complete()) — not
    // record.submittedHash, which is the pre-execution snapshot. Consulting
    // the old hash could dead-letter a new attempt that never submitted
    // anything, just because the previous attempt's transaction was found
    // on-chain. When there is no outcome hash (uncaught-error path), the
    // snapshot is the only hash available and is used as before.
    const currentHash =
      typeof extraUpdate?.submittedHash === "string"
        ? (extraUpdate.submittedHash as string)
        : (record.submittedHash ?? null);
    if (this.preCheck && currentHash) {
      const decision = await this.evaluateRetryWithPreCheck(record, attempt, classification, currentHash);
      shouldRetry = decision.shouldRetry;
      nextRetryAt = decision.nextRetryAt;
    } else {
      const decision = shouldRetryNow(record.id, attempt, classification, this.retryPolicy, this.nowFn);
      shouldRetry = decision.shouldRetry;
      nextRetryAt = decision.nextRetryAt;
    }

    if (shouldRetry) {
      await this.store.updateIfStatus(record.id, "executing", {
        status: "failed",
        nextRetryAt,
      });
    } else {
      await this.store.updateIfStatus(record.id, "executing", {
        status: "dead_letter",
        nextRetryAt: null,
        completedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Evaluate retry decision with Horizon pre-check for ambiguous submissions.
   * Decision matrix:
   * - submittedHash found on-chain → NO retry (transaction exists)
   * - network_error / ambiguous → NO blind retry (preserve state)
   * - definitive not_found → retry only if existing policy allows
   *
   * @param submittedHash — the CURRENT attempt's hash (from the pipeline
   * outcome), never the pre-execution snapshot's hash (#378).
   */
  private async evaluateRetryWithPreCheck(
    record: ExecutionRecord,
    attempt: number,
    classification: string,
    submittedHash?: string | null
  ): Promise<{ shouldRetry: boolean; nextRetryAt: string | null }> {
    const hash = submittedHash ?? record.submittedHash;
    if (!hash || !this.preCheck) {
      // Fall back to existing policy if no pre-check available
      return shouldRetryNow(record.id, attempt, classification, this.retryPolicy, this.nowFn);
    }

    let preCheckResult: PreCheckResult;
    try {
      preCheckResult = await this.preCheck(hash);
    } catch {
      // Pre-check itself failed — treat as ambiguous, do NOT blind retry
      return { shouldRetry: false, nextRetryAt: null };
    }

    switch (preCheckResult) {
      case "found":
        // Transaction exists on-chain → do NOT retry, do NOT blind resubmit
        return { shouldRetry: false, nextRetryAt: null };
      case "network_error":
        // Ambiguous network state → do NOT blind retry
        return { shouldRetry: false, nextRetryAt: null };
      case "not_found":
        // Only definitive not_found allows retry under existing policy
        if (classification === "permanent") {
          return { shouldRetry: false, nextRetryAt: null };
        }
        if (attempt >= this.retryPolicy.maxRetries) {
          return { shouldRetry: false, nextRetryAt: null };
        }
        return { shouldRetry: true, nextRetryAt: computeNextRetryAt(attempt, this.retryPolicy, new Date()) };
    }
  }
}

export interface ExecutionQueueOptions {
  intervalMs?: number;
  concurrency?: number;
  clock?: () => Date;
  now?: () => Date;
  retryPolicy?: RetryPolicy;
  /** Pre-check function to verify transaction status before blind retry */
  preCheck?: PreCheckFn;
}

function classifyUncaughtError(error: unknown): "transient" | "permanent" {
  if (error instanceof Error) {
    return isTransientMessage(error.message) ? ("transient" as const) : ("permanent" as const);
  }
  return "transient" as const;
}

const TRANSIENT_PATTERNS: (string | RegExp)[] = [
  /network/i,
  /fetch/i,
  /timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /socket/i,
  /horizon/i,
  /server error/i,
  /503/,
  /429/,
  /account fetch error/i,
  /transaction submission failed/i,
];

function isTransientMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => {
    if (typeof p === "string") return lower.includes(p);
    return p.test(lower);
  });
}

function shouldRetryNow(
  _executionId: string,
  attempt: number,
  errorClass: string,
  policy: RetryPolicy,
  now: () => Date
): { shouldRetry: boolean; nextRetryAt: string | null } {
  if (errorClass === "permanent") {
    return { shouldRetry: false, nextRetryAt: null };
  }
  if (attempt >= policy.maxRetries) {
    return { shouldRetry: false, nextRetryAt: null };
  }
  return { shouldRetry: true, nextRetryAt: computeNextRetryAt(attempt, policy, now()) };
}

