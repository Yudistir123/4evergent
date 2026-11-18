import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import { type PolicyRules } from "./types.js";
import { normalizePolicyRules } from "./validation.js";
import { parseStrictAmount } from "./amount.js";

/**
 * PolicyEngine — deterministic, pure policy evaluation.
 *
 * SECURITY: Policy evaluation is the single gate that decides whether an
 * intent is allowed to proceed toward signing. It MUST be:
 *   - deterministic (same input → same output)
 *   - LLM-independent (no LLM involvement)
 *   - side-effect free EXCEPT for daily spending reservation (see below)
 *
 * The daily spending limit check requires reading persisted activity data
 * and atomically reserving the amount. For this reason, `evaluate()` is async.
 * An ActivityStore can be provided at construction time; without it, the
 * daily limit check is skipped.
 *
 * Phase 28J: Supports optional agent-scoped rule resolution via getRules callback.
 * When provided, evaluate() resolves rules per-agent before enforcement.
 * If getRules returns null/undefined, the defaultRules from construction are used.
 *
 * Phase 28J: `evaluateWithoutReservation()` performs policy checks without reserving
 * daily spending. Used by executeApproved() to re-evaluate current policy without
 * double-reserving (the reservation was already done at intent-creation time).
 *
 * #353: reservation happens at exactly ONE step, AFTER every deny-only check
 * (amount, tx type, max-tx, allowlists) and BEFORE the approval threshold, so
 * a denied intent never reserves. A successful reservation is recorded on the
 * returned PolicyDecision as `reservedDailySpending`; the holder must release
 * it if the intent never executes (see ActivityStore.releaseDailySpending).
 */
export interface EvaluateOptions {
  /** Skip daily spending reservation (for re-evaluation in approve path). */
  skipReservation?: boolean;
}

export class PolicyEngine {
  private defaultRules: PolicyRules;
  private activityStore?: {
    listByAgent: (agentId: string, limit?: number) => Promise<ActivityRecord[]>;
    reserveDailySpending?: (agentId: string, asset: string, amount: string, limit: string) => Promise<boolean>;
    releaseDailySpending?: (agentId: string, asset: string, amount: string) => Promise<void>;
    /** Reservation-table total for the current UTC day (single source of "spent", #353). */
    getDailySpending?: (agentId: string, asset: string, now?: Date) => Promise<number | null>;
  };
  private getRules?: (agentId: string) => Promise<PolicyRules | null>;

  constructor(
    rules?: Partial<PolicyRules>,
    activityStore?: {
      listByAgent: (agentId: string, limit?: number) => Promise<ActivityRecord[]>;
      reserveDailySpending?: (agentId: string, asset: string, amount: string, limit: string) => Promise<boolean>;
      releaseDailySpending?: (agentId: string, asset: string, amount: string) => Promise<void>;
      getDailySpending?: (agentId: string, asset: string, now?: Date) => Promise<number | null>;
    },
    getRules?: (agentId: string) => Promise<PolicyRules | null>
  ) {
    this.defaultRules = normalizePolicyRules(rules ?? {});
    this.activityStore = activityStore;
    this.getRules = getRules;
  }

  /**
   * Evaluate an intent against the policy rules for the given agent.
   *
   * If a getRules callback was provided at construction, it is used to
   * resolve agent-specific rules (e.g., from persisted configuration).
   * If the callback returns null/undefined, the defaultRules from
   * construction are used as fallback.
   *
   * This method performs daily spending reservation when applicable.
   */
  async evaluate(intent: AgentIntent, agentId: string, options?: EvaluateOptions): Promise<PolicyDecision> {
    // Resolve rules: agent-specific if callback returns rules, otherwise fallback to defaultRules
    let rules = this.defaultRules;
    if (this.getRules) {
      const resolved = await this.getRules(agentId);
      if (resolved) {
        rules = resolved;
      }
    }
    return this.evaluateWithRules(intent, agentId, rules, options);
  }

  /**
   * Evaluate against a specific set of rules (internal).
   *
   * @param options.skipReservation — when true, daily spending limit is checked
   *   for denial but NOT reserved. Used by executeApproved to re-evaluate policy
   *   without double-reserving (reservation already occurred at intent creation).
   */
  private async evaluateWithRules(
    intent: AgentIntent,
    agentId: string,
    rules: PolicyRules,
    options?: EvaluateOptions
  ): Promise<PolicyDecision> {
    // #353: set ONLY by a successful daily-spending reservation below.
    // Attached to every later decision (allow / requires_approval) so the
    // holder can release exactly this reservation if the intent never
    // executes. Denies never carry it: allowlist/max-tx checks run BEFORE
    // the reservation step, and a failed reservation leaves it unset.
    let reserved: { asset: string; amount: string } | undefined;
    const decide = (
      result: PolicyDecision["result"],
      reason: string,
      rule: string
    ): PolicyDecision => ({
      result,
      reason,
      rule,
      intent,
      ...(reserved ? { reservedDailySpending: reserved } : {}),
    });

    // 0. Amount validation — reject zero, negative, or non-numeric.
    // Strict: "10abc" and "1e2" are not amounts, even though parseFloat
    // would silently read 10 / 100 out of them (#264).
    const amountStr = extractAmount(intent);
    const amountNum = amountStr !== null ? parseStrictAmount(amountStr) : null;
    if (amountStr !== null) {
      if (amountNum === null) {
        // A well-formed negative amount ("-10") keeps the historical
        // "must be positive" reason; anything else is malformed.
        if (/^-\d+(?:\.\d{1,7})?$/.test(amountStr)) {
          return decide("deny", `Amount must be positive, got ${Number(amountStr)}`, "positiveAmount");
        }
        return decide("deny", `Invalid amount: '${amountStr}' is not a valid number`, "invalidAmount");
      }
      if (amountNum <= 0) {
        return decide("deny", `Amount must be positive, got ${amountNum}`, "positiveAmount");
      }
    }

    // 1. Transaction type restriction
    const typeAllowed = rules.txTypeRestrictions[intent.type];
    if (typeAllowed !== true) {
      return decide("deny", `Transaction type '${intent.type}' is not permitted`, "txTypeRestrictions");
    }

    const amount = extractAmount(intent);
    const asset = extractAsset(intent);

    // 2. Per-transaction max amount
    if (amount !== null) {
      const maxForAsset = rules.maxTxAmount[asset] ?? rules.maxTxAmount["native"];
      if (maxForAsset && compareAmounts(amount, maxForAsset) > 0) {
        return decide("deny", `Amount ${amount} ${asset} exceeds max_tx_amount ${maxForAsset}`, "maxTxAmount");
      }
    }

    // 3. Asset allowlist
    // #353: allowlist checks run BEFORE the daily-spending reservation, so
    // an intent denied here never reserves (previously step 3 reserved first
    // and the reservation leaked until end of day).
    if (rules.allowedAssets.length > 0 && !rules.allowedAssets.includes(asset)) {
      return decide("deny", `Asset '${asset}' is not in allowed_assets`, "allowedAssets");
    }

    // 4. Destination allowlist (payments only)
    if (intent.type === "payment" && rules.allowedDestinations.length > 0) {
      if (!rules.allowedDestinations.includes(intent.destination)) {
        return decide("deny", `Destination '${intent.destination}' not in allowed_destinations`, "allowedDestinations");
      }
    }

    // 5. Contract ID allowlist (contract calls only)
    if (intent.type === "contract_call" && rules.allowedContractIds.length > 0) {
      if (!rules.allowedContractIds.includes(intent.contractId)) {
        return decide("deny", `Contract '${intent.contractId}' not in allowed list`, "allowedContractIds");
      }
    }

    // 6. Daily spending limit (requires persisted activity data)
    // This is the ONLY step that reserves: one evaluate() = at most one
    // reservation, and only for intents that passed every deny check above.
    if (amountStr !== null && this.activityStore) {
      const dailyLimit = rules.dailySpendingLimit[asset] ?? rules.dailySpendingLimit["native"];
      if (dailyLimit) {
        if (options?.skipReservation) {
          // Skip reservation but still check the limit (read-only).
          // Used by executeApproved to verify tightened policy without double-reserving.
          // A malformed limit can only come from rules that bypassed
          // validatePolicyRules; fall back to NaN so the comparison is
          // false, exactly as the old parseFloat path behaved.
          const limitNum = parseStrictAmount(dailyLimit) ?? Number.NaN;
          // #353: read the reservation table (the same source the spending
          // endpoint reports), NOT the submitted-activity sum. The table
          // already includes this intent's own reservation from creation
          // time, so the check is simply: does the CURRENT limit still
          // cover everything already reserved? If policy was tightened
          // below the reserved total, deny.
          const reservedTotal = await this.getReservedTotal(asset, agentId);
          if (reservedTotal !== null) {
            if (reservedTotal > limitNum) {
              return decide(
                "deny",
                `Amount ${amountStr} ${asset} exceeds daily limit: reserved ${reservedTotal.toFixed(7)}, limit ${limitNum}`,
                "dailySpendingLimit"
              );
            }
          } else {
            // Store cannot report reservations (e.g. a minimal test double):
            // fall back to the pre-#353 submitted-activity check.
            const spent = await this.getDailySpent(asset, agentId);
            const remaining = limitNum - spent;
            if ((amountNum as number) > remaining) {
              return decide(
                "deny",
                `Amount ${amountStr} ${asset} exceeds daily limit: spent ${spent.toFixed(7)}, limit ${limitNum}, remaining ${remaining.toFixed(7)}`,
                "dailySpendingLimit"
              );
            }
          }
        } else if (this.activityStore.reserveDailySpending) {
          const reservedOk = await this.activityStore.reserveDailySpending(
            agentId, asset, amountStr, dailyLimit
          );
          if (!reservedOk) {
            return decide(
              "deny",
              `Amount ${amountStr} ${asset} exceeds daily limit (atomically reserved failed)`,
              "dailySpendingLimit"
            );
          }
          reserved = { asset, amount: amountStr };
        } else {
          const spent = await this.getDailySpent(asset, agentId);
          // See the skipReservation branch above for the NaN fallback.
          const limitNum = parseStrictAmount(dailyLimit) ?? Number.NaN;
          const remaining = limitNum - spent;
          if ((amountNum as number) > remaining) {
            return decide(
              "deny",
              `Amount ${amountStr} ${asset} exceeds daily limit: spent ${spent.toFixed(7)}, limit ${limitNum}, remaining ${remaining.toFixed(7)}`,
              "dailySpendingLimit"
            );
          }
        }
      }
    }

    // 7. Approval threshold
    if (amount !== null) {
      const threshold = rules.requireHumanApprovalForAmountAbove;
      if (threshold && compareAmounts(amount, threshold) >= 0) {
        return decide("requires_approval", `Amount ${amount} ${asset} requires human approval (>= ${threshold})`, "approvalThreshold");
      }
    }

    return decide("allow", "All policy checks passed", "default");
  }

  /**
   * Reservation-table total for (agent, asset) today (#353) — the same
   * source the spending endpoint reports. Returns null when the store
   * cannot report reservations, so callers can fall back to the activity
   * sum. Only "submitted" activities counted by getDailySpent are NOT used
   * here: pending approvals hold real reservations and must count.
   */
  private async getReservedTotal(asset: string, agentId: string): Promise<number | null> {
    if (!this.activityStore?.getDailySpending) return null;
    const total = await this.activityStore.getDailySpending(agentId, asset);
    return total ?? 0;
  }

  /**
   * Calculates the total amount of `asset` spent by the agent today
   * (UTC day boundary), based on submitted activities.
   *
   * Only activities with status "submitted" are counted. Pending, rejected,
   * and failed activities do NOT count toward the daily limit.
   */
  private async getDailySpent(asset: string, agentId: string): Promise<number> {
    if (!this.activityStore) return 0;

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfDayIso = startOfDay.toISOString();

    const activities = await this.activityStore.listByAgent(agentId, 200);

    let total = 0;
    for (const activity of activities) {
      if (activity.status !== "submitted") continue;
      if (activity.createdAt < startOfDayIso) continue;
      const activityAsset = extractAsset(activity.intent);
      if (activityAsset !== asset) continue;
      const amount = extractAmount(activity.intent);
      if (amount !== null) {
        // Malformed stored amounts contribute 0 rather than the
        // parseFloat-truncated value, so the gate and the ledger agree.
        total += parseStrictAmount(amount) ?? 0;
      }
    }

    return total;
  }
}

function extractAmount(intent: AgentIntent): string | null {
  if (intent.type === "payment") return intent.amount;
  if (intent.type === "trustline" && intent.limit) return intent.limit;
  return null;
}

function extractAsset(intent: AgentIntent): string {
  if (intent.type === "payment") {
    if (intent.assetDetails) {
      if (intent.assetDetails.code === "XLM") return "XLM";
      return `${intent.assetDetails.code}:${intent.assetDetails.issuer}`;
    }
    return intent.asset;
  }
  if (intent.type === "trustline") {
    return `trustline:${intent.assetCode}:${intent.issuer}`;
  }
  return "native";
}

function compareAmounts(a: string, b: string): number {
  const pa = parseStrictAmount(a);
  const pb = parseStrictAmount(b);
  if (pa === null || pb === null) return 0;
  return pa > pb ? 1 : pa < pb ? -1 : 0;
}

interface ActivityRecord {
  id: string;
  agentId: string;
  intent: AgentIntent;
  status: string;
  createdAt: string;
}
