import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createActivity,
  createApproval,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  type ActivityStore,
  type ApprovalStore,
} from "@4evergent/database";
import { PolicyEngine } from "@4evergent/policy";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";

// #353: the pipeline evaluates policy exactly once per submission and releases
// the daily-spending reservation when the intent never executes.

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const TX_HASH = "submitted-transaction-hash";
const DEST = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const intent: AgentIntent = {
  type: "payment",
  asset: "XLM",
  destination: DEST,
  amount: "300",
  reason: "353 test",
};

const POLICY_RULES = {
  maxTxAmount: { XLM: "400" },
  dailySpendingLimit: { XLM: "500" },
  allowedAssets: ["XLM"],
  requireHumanApprovalForAmountAbove: "100",
  approvalThreshold: "100",
  txTypeRestrictions: { payment: true },
};

/** Same limits, but no approval threshold — direct-execution path. */
const POLICY_RULES_EXEC = {
  ...POLICY_RULES,
  requireHumanApprovalForAmountAbove: "10000",
  approvalThreshold: "10000",
};

class TestSigner implements Signer {
  calls = 0;
  getAccountId(): string {
    return DEST;
  }
  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }
  async sign(): Promise<any> {
    this.calls++;
    return { hash: () => Buffer.from("pre-submit-hash") };
  }
}

function makeStores(backend: "InMemory" | "SQLite"): {
  activityStore: ActivityStore;
  approvalStore: ApprovalStore;
  cleanup: () => void;
} {
  if (backend === "InMemory") {
    return {
      activityStore: new InMemoryActivityStore(),
      approvalStore: new InMemoryApprovalStore(),
      cleanup: () => {},
    };
  }
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-353-"));
  const dbPath = join(tmp, "test.db");
  const activityStore = new SQLiteActivityStore(dbPath);
  const approvalStore = new SQLiteApprovalStore(dbPath);
  return {
    activityStore,
    approvalStore,
    cleanup: () => {
      activityStore.close();
      approvalStore.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function reserved(store: ActivityStore, agentId = "agent-1"): Promise<number> {
  return (await store.getDailySpending(agentId, "XLM")) ?? 0;
}

function mockInternals(
  pipeline: TransactionPipeline,
  options: {
    simulate?: () => Promise<object>;
    submit?: () => Promise<{ hash: string; ledger: number }>;
  } = {}
): void {
  const internals = pipeline as unknown as {
    builder: { buildPayment: () => Promise<object>; buildAccountSettings: () => Promise<object> };
    simulator: { simulate: () => Promise<object> };
    submitter: { submit: () => Promise<{ hash: string; ledger: number }> };
  };
  internals.builder = {
    buildPayment: async () => ({ fakeTransaction: true }),
    buildAccountSettings: async () => ({ fakeTransaction: true }),
  };
  internals.simulator = {
    simulate:
      options.simulate ??
      (async () => ({ success: true, fee: "100", operations: 1, warnings: [] })),
  };
  internals.submitter = {
    submit: options.submit ?? (async () => ({ hash: TX_HASH, ledger: 123 })),
  };
}

function sourceAccount() {
  return {
    accountId: () => DEST,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    agentId: "agent-1",
    ownerId: "owner-1",
  } as any;
}

async function withOfflineAccount<T>(run: () => Promise<T>): Promise<T> {
  const originalGetAccount = StellarAdapter.prototype.getAccount;
  StellarAdapter.prototype.getAccount = async () => ({
    address: DEST,
    sequence: "1",
    balances: [],
    subentryCount: 0,
  });
  try {
    return await run();
  } finally {
    StellarAdapter.prototype.getAccount = originalGetAccount;
  }
}

/**
 * Create a pending approval the way the real flow does: evaluate the intent
 * through the engine (reserves once), then persist the activity + approval
 * carrying that decision (with reservedDailySpending attached).
 */
async function createReservedApproval(
  activityStore: ActivityStore,
  approvalStore: ApprovalStore,
  opts: { expiresAt?: string | null; amount?: string } = {}
): Promise<{ approval: Awaited<ReturnType<typeof approvalStore.get>>; decision: PolicyDecision }> {
  const engine = new PolicyEngine(POLICY_RULES, activityStore as any);
  const useIntent = opts.amount ? { ...intent, amount: opts.amount } : intent;
  const decision = await engine.evaluate(useIntent, "agent-1");
  assert.equal(decision.result, "requires_approval");
  assert.ok(decision.reservedDailySpending, "creation must reserve");
  const activity = createActivity("agent-1", "owner-1", useIntent, decision);
  activity.status = "requires_approval";
  activity.authorizationStatus = "pending_approval";
  await activityStore.record(activity);
  const approval = createApproval(
    activity.id,
    "agent-1",
    "owner-1",
    useIntent,
    decision,
    opts.expiresAt ?? new Date(Date.now() + 60_000).toISOString()
  );
  approval.status = "approved";
  await approvalStore.record(approval);
  return { approval, decision };
}

const BACKENDS = ["InMemory", "SQLite"] as const;

for (const backend of BACKENDS) {
  test(`#353 [${backend}] execute() with caller-supplied decision reserves exactly once on success`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const engine = new PolicyEngine(POLICY_RULES_EXEC, activityStore as any);
      const decision = await engine.evaluate(intent, "agent-1");
      assert.equal(decision.result, "allow");

      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: POLICY_RULES_EXEC,
      });
      mockInternals(pipeline);

      // Handler path: decision supplied, pipeline must NOT re-evaluate.
      const outcome = await pipeline.execute({ intent, sourceAccount: sourceAccount(), policyDecision: decision });
      assert.equal(outcome.status, "submitted");
      assert.equal(await reserved(activityStore), 300, "one intent = one reservation of 300, not 600");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] execute() without a decision (schedule/queue path) also reserves exactly once`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: POLICY_RULES_EXEC,
      });
      mockInternals(pipeline);

      const outcome = await pipeline.execute({ intent, sourceAccount: sourceAccount() });
      assert.equal(outcome.status, "submitted");
      assert.equal(await reserved(activityStore), 300);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] execute() simulation failure releases the reservation`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const engine = new PolicyEngine(POLICY_RULES_EXEC, activityStore as any);
      const decision = await engine.evaluate(intent, "agent-1");
      assert.equal(decision.result, "allow");
      assert.equal(await reserved(activityStore), 300);

      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: POLICY_RULES_EXEC,
      });
      mockInternals(pipeline, {
        simulate: async () => ({ success: false, fee: "100", operations: 1, warnings: [], error: "mock sim failure" }),
      });

      const outcome = await pipeline.execute({ intent, sourceAccount: sourceAccount(), policyDecision: decision });
      assert.equal(outcome.status, "simulation_failed");
      assert.equal(await reserved(activityStore), 0, "failed execution must release the reservation");
      // Freed amount is spendable again.
      const retry = await engine.evaluate(intent, "agent-1");
      assert.equal(retry.result, "allow");
      assert.equal(await reserved(activityStore), 300);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] execute() submission failure releases the reservation`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const engine = new PolicyEngine(POLICY_RULES_EXEC, activityStore as any);
      const decision = await engine.evaluate(intent, "agent-1");
      assert.equal(decision.result, "allow");
      assert.equal(await reserved(activityStore), 300);

      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: POLICY_RULES_EXEC,
      });
      mockInternals(pipeline, {
        submit: async () => {
          throw new Error("mock submit failure");
        },
      });

      const outcome = await pipeline.execute({ intent, sourceAccount: sourceAccount(), policyDecision: decision });
      assert.equal(outcome.status, "rejected");
      assert.match(outcome.message, /Submission failed/);
      assert.equal(await reserved(activityStore), 0, "failed submission must release the reservation");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] executeApproved: expired approval releases the reservation`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const { approval } = await createReservedApproval(activityStore, approvalStore, {
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      assert.equal(await reserved(activityStore), 300);

      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: POLICY_RULES,
      });
      mockInternals(pipeline);

      const result = await pipeline.executeApproved(approval!.id, "reviewer-1");
      assert.equal(result.status, "rejected");
      assert.equal(result.message, "Approval has expired");
      assert.equal(await reserved(activityStore), 0, "expired approval must release the reservation");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] executeApproved: policy re-evaluation deny releases the reservation`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const { approval } = await createReservedApproval(activityStore, approvalStore);
      assert.equal(await reserved(activityStore), 300);

      // Policy tightened after approval: maxTx 400 -> 5.
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: { ...POLICY_RULES, maxTxAmount: { XLM: "5" } },
      });
      mockInternals(pipeline);

      const result = await pipeline.executeApproved(approval!.id, "reviewer-1");
      assert.equal(result.status, "rejected");
      assert.match(result.message, /Policy re-evaluation denied/);
      assert.equal(await reserved(activityStore), 0, "denied re-evaluation must release the reservation");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] executeApproved: submission failure releases the reservation`, async () => {
    await withOfflineAccount(async () => {
      const { activityStore, approvalStore, cleanup } = makeStores(backend);
      try {
        const { approval } = await createReservedApproval(activityStore, approvalStore);
        assert.equal(await reserved(activityStore), 300);

        const pipeline = new TransactionPipeline({
          horizonUrl: HORIZON_URL,
          networkPassphrase: PASSPHRASE,
          signer: new TestSigner(),
          activityStore,
          approvalStore,
          policyRules: POLICY_RULES,
        });
        mockInternals(pipeline, {
          submit: async () => {
            throw new Error("mock submit failure");
          },
        });

        const result = await pipeline.executeApproved(approval!.id, "reviewer-1");
        assert.equal(result.status, "rejected");
        assert.match(result.message, /Submission failed/);
        assert.equal(await reserved(activityStore), 0, "failed execution must release the reservation");
      } finally {
        cleanup();
      }
    });
  });

  test(`#353 [${backend}] executeApproved: success keeps the reservation`, async () => {
    await withOfflineAccount(async () => {
      const { activityStore, approvalStore, cleanup } = makeStores(backend);
      try {
        const { approval } = await createReservedApproval(activityStore, approvalStore);
        assert.equal(await reserved(activityStore), 300);

        const pipeline = new TransactionPipeline({
          horizonUrl: HORIZON_URL,
          networkPassphrase: PASSPHRASE,
          signer: new TestSigner(),
          activityStore,
          approvalStore,
          policyRules: POLICY_RULES,
        });
        mockInternals(pipeline);

        const result = await pipeline.executeApproved(approval!.id, "reviewer-1");
        assert.equal(result.status, "submitted");
        assert.equal(await reserved(activityStore), 300, "submitted spend stays reserved");
      } finally {
        cleanup();
      }
    });
  });

  test(`#353 [${backend}] allowlist deny takes precedence over the approval threshold (no bypass)`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      // Trustline asset is NOT in the default allowlist (["XLM"]); the
      // amount (1000) is above the approval threshold (0). Pre-#353 the
      // threshold short-circuited the allowlist and returned
      // requires_approval — and executeApproved would then have executed
      // it. Now the allowlist denies first: nothing is reserved, nothing
      // is signed, no approval is created.
      const signer = new TestSigner();
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer,
        activityStore,
        approvalStore,
        policyRules: {
          maxTxAmount: { native: "1000000" },
          requireHumanApprovalForAmountAbove: "0",
        },
      });
      mockInternals(pipeline);
      const trustline: AgentIntent = {
        type: "trustline",
        assetCode: "USDC",
        issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
        limit: "1000",
        reason: "353 allowlist precedence",
      };
      const outcome = await pipeline.execute({ intent: trustline, sourceAccount: sourceAccount() });
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.policyDecision.rule, "allowedAssets");
      assert.equal(signer.calls, 0);
      assert.equal((await approvalStore.listByAgent("agent-1")).length, 0);
      assert.equal(await reserved(activityStore), 0);
    } finally {
      cleanup();
    }
  });
}
