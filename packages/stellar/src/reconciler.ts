import type { ActivityStore, ExecutionRecord, ExecutionStore } from "@4evergent/database";

/**
 * TransactionStatus — typed result of a Stellar transaction lookup.
 *
 *   confirmed    — transaction included in a ledger and successful
 *   failed       — transaction included in a ledger but failed
 *   not_found    — transaction not found (may be pending, or may have never been submitted)
 *   network_error — could not reach Horizon (timeout, 5xx, rate limit, etc.)
 */
export type TransactionStatus = "confirmed" | "failed" | "not_found" | "network_error";

export interface TransactionStatusProvider {
  getStatus(txHash: string): Promise<TransactionStatus>;
}

/**
 * Default lifetime of a `submitted` execution that Horizon still reports as
 * `not_found` before the reconciler retires it to `failed`: 6 hours.
 *
 * Generous on purpose: a slow network must never cause a premature failure.
 * A Stellar transaction that has not landed after 6h is, in practice, never
 * going to land — it was dropped from the mempool, its timebounds expired,
 * or its fee was too low to ever be picked up.
 */
export const DEFAULT_SUBMITTED_MAX_AGE_MS = 6 * 60 * 60_000;

export interface ReconcilerOptions {
  intervalMs?: number;
  clock?: () => Date;
  /**
   * Maximum age of a `submitted` execution still reported `not_found` before
   * it is retired to `failed`. Defaults to DEFAULT_SUBMITTED_MAX_AGE_MS (6h).
   * Must be a positive finite number when provided. Only `not_found` ages:
   * a `network_error` never consumes the budget, so a Horizon outage cannot
   * retire executions.
   */
  maxAgeMs?: number;
  /**
   * Optional store for releasing the daily-spending reservation (#353) of a
   * retired execution. Only used when the retired record carries proof of a
   * reservation (`policyDecision.reservedDailySpending`); records without
   * proof (e.g. schedule-driven executions, whose decision is never written
   * back to the record) release nothing. Best-effort: a release failure is
   * swallowed so bookkeeping can never mask the retire.
   */
  activityStore?: Pick<ActivityStore, "releaseDailySpending">;
}

/**
 * TransactionStatusReconciler — polls Horizon for on-chain status of submitted
 * transactions and updates execution records accordingly.
 *
 * SAFETY:
 *   - Only processes executions with status === "submitted" AND txHash != null
 *   - Uses atomic conditional update (updateIfStatus) to prevent races
 *   - Does NOT sign, submit, or create queue records
 *   - Does NOT change confirmed/failed/dead_letter executions
 *   - Does NOT retry submission on network error or not_found
 *   - A `submitted` execution still `not_found` after maxAgeMs is retired to
 *     `failed` (atomic updateIfStatus, so a concurrent confirm wins the race
 *     and the retire is a no-op). `network_error` never ages an execution.
 *   - Stops cleanly on server shutdown
 */
export class TransactionStatusReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private intervalMs: number;
  private clock: () => Date;
  private maxAgeMs: number;
  private activityStore?: Pick<ActivityStore, "releaseDailySpending">;

  constructor(
    private executionStore: ExecutionStore,
    private statusProvider: TransactionStatusProvider,
    options: ReconcilerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
    if (
      options.maxAgeMs !== undefined &&
      (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0)
    ) {
      throw new Error(
        `Invalid reconciler maxAgeMs: expected a positive number of milliseconds, got '${options.maxAgeMs}'.`
      );
    }
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_SUBMITTED_MAX_AGE_MS;
    this.activityStore = options.activityStore;
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

  /**
   * Single reconciliation pass — queries Horizon for all submitted executions
   * and updates their status based on on-chain state.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      checked: 0,
      confirmed: 0,
      failed: 0,
      retired: 0,
      skipped: 0,
      errors: 0,
    };

    try {
      const executions = await this.executionStore.listSubmitted();
      result.checked = executions.length;

      for (const execution of executions) {
        if (!execution.txHash) {
          result.skipped++;
          continue;
        }

        let status: TransactionStatus;
        try {
          status = await this.statusProvider.getStatus(execution.txHash);
        } catch (_err) {
          result.errors++;
          continue;
        }

        if (status === "confirmed") {
          const updated = await this.executionStore.updateIfStatus(
            execution.id,
            "submitted",
            { status: "confirmed", completedAt: this.clock().toISOString(), updatedAt: this.clock().toISOString(), nextRetryAt: null }
          );
          if (updated) result.confirmed++;
        } else if (status === "failed") {
          const updated = await this.executionStore.updateIfStatus(
            execution.id,
            "submitted",
            // #378: a terminal on-chain outcome carries no retry schedule.
            // Without this, a stale nextRetryAt from an earlier attempt
            // would survive on the failed record (complete() clears it on
            // submit, but a record submitted before that fix keeps it).
            { status: "failed", error: "Transaction failed on-chain", updatedAt: this.clock().toISOString(), nextRetryAt: null }
          );
          if (updated) result.failed++;
        } else if (status === "not_found") {
          await this.retireIfOverAge(execution, result);
        }
        // network_error: leave as submitted, will retry next tick. A Horizon
        // outage must not consume the not_found age budget, so it can never
        // retire an execution on its own.
      }
    } catch (_err) {
      result.errors++;
    }

    return result;
  }

  /**
   * Retire a `submitted` execution that Horizon still reports `not_found`
   * after maxAgeMs: it never landed (dropped from mempool, timebounds
   * expired, fee too low) and would otherwise be polled forever.
   *
   * AGE ANCHOR — `updatedAt`: there is no `submittedAt` field. `updatedAt`
   * is bumped on every transition into `submitted` (execution-queue
   * `complete()`, recovery pre-check) and nothing writes a `submitted`
   * record without changing its status, so for a record still `submitted`
   * it is the time the record entered `submitted`. `createdAt` would wrongly
   * include the time spent queued before submission; `startedAt` is when the
   * record entered `executing`, i.e. before submission. An unparseable
   * timestamp is treated as young (never retired) rather than failing.
   *
   * The transition is guarded by updateIfStatus: if a concurrent confirm
   * already moved the record out of `submitted`, the retire loses the race
   * and the reservation is NOT released.
   */
  private async retireIfOverAge(
    execution: ExecutionRecord,
    result: ReconciliationResult
  ): Promise<void> {
    const submittedAtMs = Date.parse(execution.updatedAt);
    if (!Number.isFinite(submittedAtMs)) return;
    const ageMs = this.clock().getTime() - submittedAtMs;
    if (ageMs < this.maxAgeMs) return;

    const updated = await this.executionStore.updateIfStatus(
      execution.id,
      "submitted",
      {
        status: "failed",
        error: `Transaction not found on-chain after ${formatDuration(this.maxAgeMs)}; presumed dropped (never landed)`,
        updatedAt: this.clock().toISOString(),
      }
    );
    if (!updated) return;
    result.failed++;
    result.retired++;
    await this.releaseReservation(execution);
  }

  /**
   * Release the daily-spending reservation recorded on a decision (#353).
   * No-op when the decision reserved nothing or the store cannot release.
   * A release failure is swallowed: the outcome being reported must not be
   * masked by a bookkeeping error; the stale row is swept at the day
   * boundary. Mirrors TransactionPipeline.releaseReservation.
   */
  private async releaseReservation(execution: ExecutionRecord): Promise<void> {
    const reserved = execution.policyDecision?.reservedDailySpending;
    if (!reserved || !this.activityStore?.releaseDailySpending) return;
    try {
      await this.activityStore.releaseDailySpending(execution.agentId, reserved.asset, reserved.amount);
    } catch {
      // Best-effort bookkeeping — see above.
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.reconcile();
    } catch (err) {
      console.error("[reconciler] tick error:", err);
    }
    if (!this.running) return;
    this.timer = setTimeout(() => { void this.tick(); }, this.intervalMs);
  }
}

/** Human-readable duration for retire error messages: 6h, 90m, 5000ms. */
function formatDuration(ms: number): string {
  if (ms >= 3_600_000) {
    const hours = ms / 3_600_000;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
  }
  return `${ms}ms`;
}

export interface ReconciliationResult {
  checked: number;
  confirmed: number;
  failed: number;
  /** Subset of `failed`: over-age `not_found` executions retired by this pass. */
  retired: number;
  skipped: number;
  errors: number;
}
