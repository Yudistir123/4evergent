// #371 (pipeline safety net): a replayed Idempotency-Key must not execute
// a second time, even for direct pipeline callers that bypass the API
// handler's per-key lock. The terminal-winner pre-check in execute()
// replays the first outcome instead; the second evaluation's reservation
// (if any) is released, so one intent still reserves exactly once (#353).
//
// The merge rule is pinned here too: the first execution's txHash is the
// one the activity record keeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  type ActivityStore,
  type ApprovalStore,
} from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const DEST = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Direct-execution rules: no approval threshold. */
const EXEC_RULES = {
  maxTxAmount: { XLM: "400" },
  dailySpendingLimit: { XLM: "500" },
  allowedAssets: ["XLM"],
  requireHumanApprovalForAmountAbove: "10000",
  approvalThreshold: "10000",
  txTypeRestrictions: { payment: true },
};

/** Approval rules: amount 300 requires approval, daily limit 500. */
const APPROVAL_RULES = {
  ...EXEC_RULES,
  requireHumanApprovalForAmountAbove: "100",
  approvalThreshold: "100",
};

class TestSigner implements Signer {
  getAccountId(): string {
    return DEST;
  }
  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }
  async sign(): Promise<any> {
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
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-371-"));
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

function sourceAccount() {
  return {
    accountId: () => DEST,
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    agentId: "agent-1",
    ownerId: "owner-1",
  } as any;
}

function payment(amount: string): AgentIntent {
  return { type: "payment", asset: "XLM", destination: DEST, amount, reason: "371 test" };
}

/** Stub builder/simulator/submitter; each submit returns a distinct hash. */
function mockCountingSubmitter(pipeline: TransactionPipeline): () => number {
  let submitCalls = 0;
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
    simulate: async () => ({ success: true, fee: "100", operations: 1, warnings: [] }),
  };
  internals.submitter = {
    submit: async () => {
      submitCalls++;
      return { hash: `371-tx-hash-${submitCalls}`, ledger: 123 };
    },
  };
  return () => submitCalls;
}

const BACKENDS = ["InMemory", "SQLite"] as const;

for (const backend of BACKENDS) {
  test(`#371 [${backend}] pipeline: sequential replay of a submitted key does not submit again`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: EXEC_RULES,
      });
      const getSubmitCalls = mockCountingSubmitter(pipeline);

      const first = await pipeline.execute({
        intent: payment("10"),
        sourceAccount: sourceAccount(),
        idempotencyKey: "371-pipe-key",
      });
      assert.equal(first.status, "submitted");
      assert.equal(first.txHash, "371-tx-hash-1");

      const second = await pipeline.execute({
        intent: payment("10"),
        sourceAccount: sourceAccount(),
        idempotencyKey: "371-pipe-key",
      });
      // Replay: same activity, same (first) txHash, no second submission.
      assert.equal(second.status, "submitted");
      assert.equal(second.activityId, first.activityId);
      assert.equal(second.txHash, "371-tx-hash-1");
      assert.equal(getSubmitCalls(), 1);

      const records = await activityStore.listByAgent("agent-1", 50);
      assert.equal(records.length, 1);
      assert.equal(records[0].txHash, "371-tx-hash-1");
      // One reservation: the replay's evaluation reserved again, then the
      // duplicate path released it.
      assert.equal(await activityStore.getDailySpending("agent-1", "XLM"), 10);
    } finally {
      cleanup();
    }
  });

  test(`#371 [${backend}] pipeline: same key + different intent is rejected without submitting`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: EXEC_RULES,
      });
      const getSubmitCalls = mockCountingSubmitter(pipeline);

      const first = await pipeline.execute({
        intent: payment("10"),
        sourceAccount: sourceAccount(),
        idempotencyKey: "371-pipe-conflict",
      });
      assert.equal(first.status, "submitted");

      const second = await pipeline.execute({
        intent: payment("20"),
        sourceAccount: sourceAccount(),
        idempotencyKey: "371-pipe-conflict",
      });
      assert.equal(second.status, "rejected");
      assert.equal(second.activityId, first.activityId);
      assert.equal(getSubmitCalls(), 1);

      const records = await activityStore.listByAgent("agent-1", 50);
      assert.equal(records.length, 1);
      assert.equal(records[0].txHash, "371-tx-hash-1");
    } finally {
      cleanup();
    }
  });

  test(`#371 [${backend}] pipeline: replay of a requires_approval key mints no second approval`, async () => {
    const { activityStore, approvalStore, cleanup } = makeStores(backend);
    try {
      const pipeline = new TransactionPipeline({
        horizonUrl: HORIZON_URL,
        networkPassphrase: PASSPHRASE,
        signer: new TestSigner(),
        activityStore,
        approvalStore,
        policyRules: APPROVAL_RULES,
      });
      mockCountingSubmitter(pipeline);

      const first = await pipeline.execute({
        intent: payment("300"),
        sourceAccount: sourceAccount(),
        idempotencyKey: "371-pipe-approval",
      });
      assert.equal(first.status, "requires_approval");
      assert.ok(first.approvalId);

      // The replay's own evaluation denies (300 already reserved of a 500
      // limit, a second 300 would exceed it) — the replay must still
      // return the first approval, not a deny.
      const second = await pipeline.execute({
        intent: payment("300"),
        sourceAccount: sourceAccount(),
        idempotencyKey: "371-pipe-approval",
      });
      assert.equal(second.status, "requires_approval");
      assert.equal(second.activityId, first.activityId);
      assert.equal(second.approvalId, first.approvalId);

      const pending = await approvalStore.listByAgent("agent-1", 50, 0, "pending_approval");
      assert.equal(pending.length, 1);
      const records = await activityStore.listByAgent("agent-1", 50);
      assert.equal(records.length, 1);
      assert.equal(await activityStore.getDailySpending("agent-1", "XLM"), 300);
    } finally {
      cleanup();
    }
  });
}
