import { StellarTransactionBuilder } from "./transaction-builder.js";
import { StellarSimulator } from "./simulator.js";
import { StellarSubmitter } from "./submitter.js";
import type { Signer } from "./signer.js";
import { PolicyEngine } from "@4evergent/policy";
import { IntentValidator } from "@4evergent/agent-core";
import { StellarAdapter } from "@4evergent/agent-core";
import type { AgentIntent, AccountSettingsIntent, PolicyDecision, PolicyRules, ActivityRecord } from "@4evergent/shared";
import {
  createActivity,
  createApproval,
  type ActivityStore,
  type ApprovalStore,
} from "@4evergent/database";

export interface PipelineOptions {
  horizonUrl: string;
  networkPassphrase: string;
  signer: Signer;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  policyRules?: Partial<PolicyRules>;
  approvalTtlSeconds?: number;
  /** Shared policy resolver. When provided, pipeline resolves per-agent rules at execution time. */
  policyResolver?: (agentId: string) => Promise<PolicyRules>;
}

export interface PipelineExecuteInput {
  intent: AgentIntent;
  sourceAccount: any;
  idempotencyKey?: string | null;
  /** Pre-existing activity ID to update instead of creating a new ActivityRecord. */
  activityId?: string;
  signal?: AbortSignal;
  onBeforeSubmit?: () => void | Promise<void>;
  /**
   * Policy decision already obtained by the caller (#353). When provided,
   * the pipeline MUST NOT re-evaluate policy: the caller's evaluation
   * already reserved daily spending exactly once, and a second evaluation
   * would reserve a second time. Callers without a decision (schedule,
   * execution queue) omit it and the pipeline evaluates once itself.
   */
  policyDecision?: PolicyDecision;
}

/**
 * Options for `executeApproved` (issue #275).
 *
 * The queue path dispatches approved records here instead of `execute()`,
 * so it needs the same abort/cancellation parity `execute()` has: an
 * AbortSignal that throws AbortError, and an `onBeforeSubmit` hook invoked
 * (with abort re-checked) immediately before submission.
 */
export interface ExecuteApprovedOptions {
  signal?: AbortSignal;
  onBeforeSubmit?: () => void | Promise<void>;
}

export class TransactionPipeline {
  private builder: StellarTransactionBuilder;
  private simulator: StellarSimulator;
  private submitter: StellarSubmitter;
  private signer: Signer;
  private policy: PolicyEngine;
  private activityStore?: ActivityStore;
  private approvalStore?: ApprovalStore;
  private approvalTtlSeconds: number;
  private horizonUrl: string;
  private policyResolver?: (agentId: string) => Promise<PolicyRules>;

  constructor(options: PipelineOptions) {
    this.builder = new StellarTransactionBuilder();
    this.simulator = new StellarSimulator(options.horizonUrl);
    this.submitter = new StellarSubmitter(options.horizonUrl);
    this.signer = options.signer;
    this.horizonUrl = options.horizonUrl;
    this.activityStore = options.activityStore;
    this.approvalStore = options.approvalStore;
    this.approvalTtlSeconds = options.approvalTtlSeconds ?? 86400;
    this.policyResolver = options.policyResolver;
    // PolicyEngine uses getRules callback for per-agent resolution; falls back to defaultRules
    this.policy = new PolicyEngine(options.policyRules, options.activityStore as any, options.policyResolver);
  }

  async execute(input: PipelineExecuteInput): Promise<PipelineOutcome> {
    const { intent, sourceAccount, idempotencyKey, activityId, signal } = input;

    const checkAbort = () => {
      if (signal?.aborted) {
        const err = new Error("Execution was cancelled");
        err.name = "AbortError";
        throw err;
      }
    };
    checkAbort();

    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return {
        status: "rejected",
        message: `Intent validation failed: ${validation.error}`,
        policyDecision: { result: "deny", reason: "invalid intent", rule: "intent_validation", intent },
        simulationResult: null,
      };
    }

    const agentId = (sourceAccount as any)?.agentId ?? (sourceAccount as any)?.accountId?.() ?? "unknown";
    const ownerId = (sourceAccount as any)?.ownerId ?? "unknown";
    // #353: single evaluation per submission. A caller-supplied decision is
    // used as-is (its evaluation already reserved once); otherwise evaluate
    // once here. Never both.
    const decision = input.policyDecision ?? await this.policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      // Post-#353 the engine reserves only after every deny check, so a
      // deny normally carries no reservation. Release defensively anyway:
      // a no-op when reservedDailySpending is absent.
      await this.releaseReservation(agentId, decision);
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "rejected";
      activity.authorizationStatus = "denied_by_policy";
      activity.error = decision.reason;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Policy denied: ${decision.reason}`,
        policyDecision: decision,
        simulationResult: null,
        activityId: activity.id,
      };
    }

    if (decision.result === "requires_approval") {
      if (this.activityStore && this.approvalStore) {
        const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
        activity.status = "requires_approval";
        activity.authorizationStatus = "pending_approval";
        const expiresAt = new Date(Date.now() + this.approvalTtlSeconds * 1000).toISOString();
        const approval = createApproval(activity.id, agentId, ownerId, intent, decision, expiresAt);
        await this.persistActivity(activity, idempotencyKey, activityId);
        await this.approvalStore.record(approval);
        return {
          status: "requires_approval",
          message: decision.reason,
          policyDecision: decision,
          simulationResult: null,
          activityId: activity.id,
          approvalId: approval.id,
        };
      }
      return {
        status: "requires_approval",
        message: decision.reason,
        policyDecision: decision,
        simulationResult: null,
      };
    }

    checkAbort();

    let tx;
    try {
      if (intent.type === "trustline") {
        tx = await this.builder.buildTrustline(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      } else if (intent.type === "account_settings") {
        tx = await this.builder.buildAccountSettings(sourceAccount, intent as AccountSettingsIntent, this.signer.getNetworkPassphrase());
      } else {
        tx = await this.builder.buildPayment(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      }
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      // #353: construction failed — the intent will never execute, release
      // its daily-spending reservation.
      await this.releaseReservation(agentId, decision);
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "rejected";
      activity.error = e.message;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Transaction construction failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: null,
        activityId: activity.id,
      };
    }

    checkAbort();

    const simResult = await this.simulator.simulate(tx);
    if (!simResult.success) {
      // #353: simulation failed — the intent will never execute, release
      // its daily-spending reservation.
      await this.releaseReservation(agentId, decision);
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.authorizationStatus = "denied_by_simulation";
      activity.error = simResult.error ?? "Simulation failed";
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "simulation_failed",
        message: simResult.error ?? "Simulation failed",
        policyDecision: decision,
        simulationResult: simResult,
        activityId: activity.id,
      };
    }

    checkAbort();

    let signedTx;
    try {
      signedTx = await this.signer.sign(tx);
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      // #353: signing failed — the intent will never execute, release its
      // daily-spending reservation.
      await this.releaseReservation(agentId, decision);
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.error = e.message;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Signing failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
        activityId: activity.id,
      };
    }

    checkAbort();
    await input.onBeforeSubmit?.();
    checkAbort();

    // PERSIST txHash BEFORE submit to survive crash window.
    // If process crashes after submit but before we return, the txHash is already
    // in the activity record so reconciliation can detect it.
    const preSubmitHash = signedTx.hash().toString("hex");

    try {
      const result = await this.submitter.submit(signedTx, this.signer.getNetworkPassphrase());
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "submitted";
      activity.authorizationStatus = "approved";
      activity.txHash = result.hash;
      activity.simulationResult = simResult;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "submitted",
        message: `Transaction submitted: ${result.hash}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: result.hash,
        activityId: activity.id,
        submittedHash: result.hash,
      };
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      // #353: submission failed — the intent did not execute, release its
      // daily-spending reservation.
      await this.releaseReservation(agentId, decision);
      // Submit failed — record pre-submit hash + error for recovery/reconciliation
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.error = e.message;
      activity.txHash = preSubmitHash;
      activity.simulationResult = simResult;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Submission failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: preSubmitHash,
        activityId: activity.id,
      };
    }
  }

  /**
   * executeApproved — re-evaluates CURRENT policy before execution.
   *
   * SECURITY: Approval does NOT bypass policy. The intent is re-evaluated against
   * the agent's CURRENT policy at execution time. If policy was tightened between
   * approval and execution, the execution is denied.
   */
  async executeApproved(
    approvalId: string,
    approver?: string,
    options?: ExecuteApprovedOptions
  ): Promise<PipelineOutcome> {
    // Abort parity with execute(): cancellation throws AbortError instead
    // of returning a rejection, so the queue treats it as a cancel, not a
    // failure to retry (#275).
    const checkAbort = () => {
      if (options?.signal?.aborted) {
        const err = new Error("Execution was cancelled");
        err.name = "AbortError";
        throw err;
      }
    };
    checkAbort();

    if (!this.approvalStore || !this.activityStore) {
      return {
        status: "rejected",
        message: "Pipeline not configured with approval store",
        policyDecision: { result: "deny", reason: "misconfigured", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    const approval = await this.approvalStore.get(approvalId);
    if (!approval) {
      return {
        status: "rejected",
        message: `Approval ${approvalId} not found`,
        policyDecision: { result: "deny", reason: "not found", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    if (approval.status === "submitted" || approval.status === "confirmed") {
      return {
        status: "rejected",
        message: `Approval already executed with transaction ${approval.txHash ?? "unknown"}`,
        policyDecision: { result: "deny", reason: "already executed", rule: "approval", intent: approval.intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    if (approval.status !== "approved") {
      return {
        status: "rejected",
        message: `Approval is ${approval.status}, not approved`,
        policyDecision: { result: "deny", reason: approval.status, rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      await this.approvalStore.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
      // #353: expired approval will never execute — release the reservation
      // made when the intent was created.
      await this.releaseApprovalReservation(approval);
      return {
        status: "rejected",
        message: "Approval has expired",
        policyDecision: { result: "deny", reason: "expired", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    // CRITICAL: Re-evaluate CURRENT policy at execution time.
    // Approval does NOT grant a bypass — if policy was tightened since approval,
    // the intent must be denied.
    // skipReservation: daily spending was already reserved at intent-creation time.
    // Re-evaluating here must NOT double-reserve.
    checkAbort();
    const currentDecision = await this.policy.evaluate(approval.intent, approval.agentId, { skipReservation: true });
    if (currentDecision.result === "deny") {
      await this.approvalStore.update(approvalId, { status: "failed", error: `Policy re-evaluation denied: ${currentDecision.reason}` });
      // #353: tightened policy denies execution — the intent will never
      // execute, release the reservation made at creation time.
      await this.releaseApprovalReservation(approval);
      return {
        status: "rejected",
        message: `Policy re-evaluation denied: ${currentDecision.reason}`,
        policyDecision: currentDecision,
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    await this.approvalStore.update(approvalId, { status: "executing" });

    checkAbort();
    const intent = approval.intent;
    const adapter = new StellarAdapter(this.horizonUrl);

    let sourceAccount: any;
    try {
      const account = await adapter.getAccount(this.signer.getAccountId());
      sourceAccount = {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
        agentId: approval.agentId,
      };
    } catch (e: any) {
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      // #353: source account unloadable — execution cannot proceed, release.
      await this.releaseApprovalReservation(approval);
      return {
        status: "rejected",
        message: `Cannot load source account: ${e.message}`,
        policyDecision: { result: "deny", reason: "account load failed", rule: "approval", intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    let tx;
    try {
      if (intent.type === "account_settings") {
        tx = await this.builder.buildAccountSettings(sourceAccount, intent as AccountSettingsIntent, this.signer.getNetworkPassphrase());
      } else {
        tx = await this.builder.buildPayment(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      }
    } catch (e: any) {
      if (options?.signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      // #353: construction failed — release the creation-time reservation.
      await this.releaseApprovalReservation(approval);
      return {
        status: "rejected",
        message: `Construction failed: ${e.message}`,
        policyDecision: { result: "deny", reason: "construction", rule: "approval", intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    checkAbort();
    const simResult = await this.simulator.simulate(tx);
    if (!simResult.success) {
      await this.approvalStore.update(approvalId, { status: "failed", error: simResult.error ?? "Simulation failed" });
      // #353: simulation failed — release the creation-time reservation.
      await this.releaseApprovalReservation(approval);
      return {
        status: "simulation_failed",
        message: simResult.error ?? "Simulation failed",
        policyDecision: { result: "deny", reason: "simulation", rule: "approval", intent },
        simulationResult: simResult,
        activityId: approval.activityId,
      };
    }

    checkAbort();
    let signedTx;
    try {
      signedTx = await this.signer.sign(tx);
    } catch (e: any) {
      if (options?.signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      // #353: signing failed — release the creation-time reservation.
      await this.releaseApprovalReservation(approval);
      return {
        status: "rejected",
        message: `Signing failed: ${e.message}`,
        policyDecision: { result: "deny", reason: "signing", rule: "approval", intent },
        simulationResult: simResult,
        activityId: approval.activityId,
      };
    }

    // Mirror execute(): run the onBeforeSubmit hook, then re-check abort,
    // immediately before submission.
    await options?.onBeforeSubmit?.();
    checkAbort();

    // PERSIST txHash BEFORE submit to survive crash window
    const preSubmitHash = signedTx.hash().toString("hex");

    try {
      const result = await this.submitter.submit(signedTx, this.signer.getNetworkPassphrase());
      // Only overwrite the approver when one was explicitly passed (the
      // queue path has none — the approver recorded at approve time must
      // survive). Previously `approver ?? null` wiped it.
      await this.approvalStore.update(approvalId, {
        status: "submitted",
        txHash: result.hash,
        approvedAt: new Date().toISOString(),
        ...(approver !== undefined ? { approver } : {}),
      });
      if (approval.activityId) {
        const existing = await this.activityStore.get(approval.activityId);
        if (existing) {
          await this.activityStore.update(approval.activityId, { status: "submitted", txHash: result.hash, simulationResult: simResult, authorizationStatus: "approved" });
        }
      }
      return {
        status: "submitted",
        message: `Transaction submitted: ${result.hash}`,
        policyDecision: currentDecision,
        simulationResult: simResult,
        txHash: result.hash,
        submittedHash: result.hash,
        activityId: approval.activityId,
      };
    } catch (e: any) {
      if (options?.signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      // #353: submission failed — release the creation-time reservation.
      await this.releaseApprovalReservation(approval);
      return {
        status: "rejected",
        message: `Submission failed: ${e.message}`,
        policyDecision: { result: "deny", reason: "submission", rule: "approval", intent },
        simulationResult: simResult,
        txHash: preSubmitHash,
        activityId: approval.activityId,
      };
    }
  }

  /**
   * Release the daily-spending reservation recorded on a decision (#353).
   * No-op when the decision reserved nothing (deny, skipReservation
   * re-check, pre-#353 decision) or the store cannot release. A release
   * failure is swallowed: the outcome being reported must not be masked
   * by a bookkeeping error; the stale row is swept at the day boundary.
   * Abort paths deliberately do NOT call this: an aborted execution is in
   * an unknown state (the transaction may have landed), so the reservation
   * is conservatively kept.
   */
  private async releaseReservation(agentId: string, decision: PolicyDecision | null | undefined): Promise<void> {
    const reserved = decision?.reservedDailySpending;
    if (!reserved || !this.activityStore?.releaseDailySpending) return;
    try {
      await this.activityStore.releaseDailySpending(agentId, reserved.asset, reserved.amount);
    } catch {
      // Best-effort bookkeeping — see above.
    }
  }

  /** Release the reservation made when the approval's intent was created. */
  private async releaseApprovalReservation(approval: {
    agentId: string;
    policyDecision: PolicyDecision;
  }): Promise<void> {
    await this.releaseReservation(approval.agentId, approval.policyDecision);
  }

  private async persistActivity(
    record: ActivityRecord,
    idempotencyKey?: string | null,
    existingActivityId?: string
  ): Promise<void> {
    if (!this.activityStore) return;

    // Schedule-driven path: update the pre-existing activity record
    // created by the scheduler callback instead of creating a duplicate.
    if (existingActivityId) {
      await this.activityStore.update(existingActivityId, {
        status: record.status,
        authorizationStatus: record.authorizationStatus,
        error: record.error,
        txHash: record.txHash,
        simulationResult: record.simulationResult,
      });
      return;
    }

    if (idempotencyKey) {
      const result = await this.activityStore.recordIdempotent(idempotencyKey, record);
      if (!result.created) {
        // Another request already reserved this key — merge the new state into existing
        await this.activityStore.update(result.record.id, {
          status: record.status,
          authorizationStatus: record.authorizationStatus,
          error: record.error,
          txHash: record.txHash,
          simulationResult: record.simulationResult,
        });
      }
    } else {
      await this.activityStore.record(record);
    }
  }

  /**
   * Returns the ActivityRecord to use for persistence.
   *
   * When the scheduler pre-creates an ActivityRecord (activityId provided),
   * we update that existing record instead of creating a new one — this
   * prevents duplicate activity records for schedule-driven executions.
   *
   * For manual intent execution (no activityId), we create a new record as before.
   */
  private resolveActivity(
    activityId: string | undefined,
    agentId: string,
    ownerId: string,
    intent: AgentIntent,
    decision: PolicyDecision,
    idempotencyKey?: string | null
  ): ActivityRecord {
    if (activityId && this.activityStore) {
      // Return a skeleton record carrying the existing id so callers can
      // set status/error/txHash fields that persistActivity will write.
      // We still call createActivity to get a well-formed skeleton, then
      // override the id to point at the pre-existing record.
      const skeleton = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      skeleton.id = activityId;
      return skeleton;
    }
    return createActivity(agentId, ownerId, intent, decision, idempotencyKey);
  }
}

export type PipelineOutcome =
  | {
  status: "submitted";
  message: string;
  policyDecision: PolicyDecision;
  simulationResult: SimulationLike;
  txHash: string;
  activityId?: string;
  approvalId?: string;
  submittedHash?: string;
  }
  | {
      status: "simulation_failed";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult: SimulationLike;
      txHash?: string | null;
      activityId?: string;
    }
  | {
      status: "requires_approval";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult?: SimulationLike | null;
      txHash?: string | null;
      activityId?: string;
      approvalId?: string;
    }
  | {
      status: "rejected";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult: SimulationLike | null;
      txHash?: string | null;
      activityId?: string;
    };

interface SimulationLike {
  success: boolean;
  fee: string;
  operations: number;
  warnings: string[];
  error?: string;
}
