import type { AuthenticatedPrincipal } from "./auth.js";

export type Network = "testnet" | "mainnet";

export interface PolicyRules {
  maxTxAmount: Record<string, string>;
  dailySpendingLimit: Record<string, string>;
  allowedAssets: string[];
  allowedDestinations: string[];
  allowedContractIds: string[];
  txTypeRestrictions: Record<string, boolean>;
  approvalThreshold: string;
  requireHumanApprovalForAmountAbove: string;
}

export type AgentStatus = "active" | "paused" | "disabled";

export type ScheduleStatus = "active" | "paused" | "disabled";

export interface CreateAgentInput {
  displayName: string;
  description?: string;
  capabilities?: string[];
  ownerId: string;
  stellarAddress?: string;
}

export type CreateAgentRequest = CreateAgentInput;

export interface Agent extends CreateAgentInput {
  id: string;
  ownerId: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

export interface RequestContext {
  /** Authenticated principal (null for unauthenticated requests). */
  principal: AuthenticatedPrincipal | null;
  /** Denormalized ownerId for convenience. Null when unauthenticated. */
  ownerId: string | null;
}

export interface AuthorizationService {
  canAccessAgent(ctx: RequestContext, agentId: string): Promise<boolean>;
  canAccessActivity(ctx: RequestContext, activityId: string): Promise<boolean>;
  canAccessApproval(ctx: RequestContext, approvalId: string): Promise<boolean>;
  canSubmitIntent(ctx: RequestContext, agentId: string): Promise<boolean>;
  canApprove(ctx: RequestContext, approvalId: string): Promise<boolean>;
  canReject(ctx: RequestContext, approvalId: string): Promise<boolean>;
  canChangeAgentStatus(ctx: RequestContext, agentId: string): Promise<boolean>;
  canAccessSchedule(ctx: RequestContext, scheduleId: string): Promise<boolean>;
  canCreateSchedule(ctx: RequestContext, agentId: string): Promise<boolean>;
  canUpdateSchedule(ctx: RequestContext, scheduleId: string): Promise<boolean>;
  canDeleteSchedule(ctx: RequestContext, scheduleId: string): Promise<boolean>;
  canPauseSchedule(ctx: RequestContext, scheduleId: string): Promise<boolean>;
  canResumeSchedule(ctx: RequestContext, scheduleId: string): Promise<boolean>;
  canDisableSchedule(ctx: RequestContext, scheduleId: string): Promise<boolean>;
}

export type IntentType = "payment" | "trustline" | "contract_call" | "account_settings";

export type AssetCode = "XLM" | string;
export type IssuerAddress = string;

export interface PaymentAsset {
  code: AssetCode;
  issuer: IssuerAddress | null;
}

export interface PaymentIntent {
  type: "payment";
  asset: string;
  assetDetails?: PaymentAsset;
  destination: string;
  amount: string;
  reason: string;
  memo?: string;
}

export interface TrustlineIntent {
  type: "trustline";
  assetCode: string;
  issuer: string;
  limit?: string;
  reason: string;
}

export interface ContractCallIntent {
  type: "contract_call";
  contractId: string;
  function: string;
  args: unknown[];
  reason: string;
}

export interface AccountSettingsIntent {
  type: "account_settings";
  setting: string;
  value: unknown;
  reason: string;
}

export type AgentIntent = PaymentIntent | TrustlineIntent | ContractCallIntent | AccountSettingsIntent;

export type PolicyResult = "allow" | "deny" | "requires_approval";

export interface PolicyDecision {
  result: PolicyResult;
  reason: string;
  rule: string;
  intent: AgentIntent;
  /**
   * Daily-spending reservation made by this evaluation (#353).
   *
   * Present ONLY when evaluate() atomically reserved `amount` of `asset`
   * for the agent/day. Whoever owns the intent after this decision MUST
   * release it via ActivityStore.releaseDailySpending if the intent never
   * executes (approval rejected/expired, execution failure). Decisions
   * produced without a reservation — denies, skipReservation re-checks,
   * and decisions created before this field existed — carry no proof of a
   * reservation, so release is skipped for them rather than guessed.
   */
  reservedDailySpending?: { asset: string; amount: string };
}

export type ActivityStatus =
  | "pending"
  | "rejected"
  | "requires_approval"
  | "approved"
  | "signed"
  | "submitted"
  | "failed";

/**
 * Authorization state for a transaction. The pipeline records this so that
 * every downstream consumer (API, activity log, UI) can see exactly why a
 * transaction was or was not allowed to reach the signer.
 */
export type AuthorizationStatus =
  | "not_required"
  | "pending_approval"
  | "approved"
  | "denied_by_policy"
  | "denied_by_simulation";

export interface ActivityRecord {
  id: string;
  agentId: string;
  ownerId: string;
  /** Opaque client Idempotency-Key, scoped by owner+agent. Null when header omitted. */
  idempotencyKey?: string | null;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus | null;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  status: ActivityStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result of an executed transaction pipeline run. The pipeline is the ONLY
 * code path that is allowed to produce this object, and only after every gate
 * (validation, policy, simulation, authorization, signing) has passed.
 */
export interface PipelineResult {
  activityId: string;
  status: ActivityStatus;
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
}

export interface SimulationResult {
  success: boolean;
  fee: string;
  operations: number;
  warnings: string[];
  error?: string;
}

export interface StellarAccount {
  address: string;
  sequence: string;
  balances: Balance[];
  subentryCount: number;
  thresholds?: { low: number; med: number; high: number };
  signers?: Signer[];
  data?: Record<string, string>;
}

export interface Balance {
  asset: string;
  balance: string;
  limit?: string;
  buyingLiabilities?: string;
  sellingLiabilities?: string;
}

export interface Signer {
  key: string;
  weight: number;
  type: string;
}

export interface NetworkInfo {
  network: string;
  horizonUrl: string;
  passphrase: string;
  protocolVersion: number;
  coreVersion: string;
  ingestLatestLedger: number;
  historyLatestLedger: number;
  oldestLedger: number;
}
