import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionStatusReconciler } from "../src/reconciler.js";
import { InMemoryExecutionStore } from "@4evergent/database";
import type { ExecutionRecord } from "@4evergent/database";

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    status: "submitted",
    policyDecision: null,
    simulationResult: null,
    txHash: "tx-hash-123",
    error: null,
    attempt: 1,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("Reconciler: submitted + confirmed → confirmed", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-1" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.confirmed, 1);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "confirmed");
  assert.ok(updated?.completedAt);
});

test("Reconciler: submitted + failed → failed", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-2" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "failed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
});

test("Reconciler: submitted + not_found → remains submitted", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-3" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "not_found" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.confirmed, 0);
  assert.equal(result.failed, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
});

test("Reconciler: submitted + network_error → remains submitted", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-4" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "network_error" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.confirmed, 0);
  assert.equal(result.failed, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "submitted");
});

test("Reconciler: txHash missing → safely skipped", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: null });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.confirmed, 0);
});

test("Reconciler: confirmed execution is not reprocessed", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "confirmed", txHash: "tx-5" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 0);
  assert.equal(result.confirmed, 0);
});

test("Reconciler: concurrency — execution changes from submitted before update → conditional update prevents stale mutation", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "submitted", txHash: "tx-6" });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });

  // Simulate concurrent state change: another actor moves execution to failed
  await store.update(execution.id, { status: "failed" });

  const result = await reconciler.reconcile();

  // Should not update because status changed from submitted to failed
  assert.equal(result.confirmed, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
});

test("Reconciler: start/stop lifecycle", async () => {
  const store = new InMemoryExecutionStore();
  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });

  assert.equal(reconciler.isRunning(), false);
  reconciler.start();
  assert.equal(reconciler.isRunning(), true);
  reconciler.stop();
  assert.equal(reconciler.isRunning(), false);
});

test("Reconciler: failed outcome clears the stale retry schedule (#378)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-5",
    nextRetryAt: "2020-01-01T00:00:00.000Z",
  });
  await store.record(execution);

  const provider = {
    getStatus: async () => "failed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.failed, 1);
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
  assert.equal(updated?.nextRetryAt, null);
});

test("Reconciler: confirmed outcome clears the stale retry schedule (#378)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "submitted",
    txHash: "tx-6",
    nextRetryAt: "2020-01-01T00:00:00.000Z",
  });
  await store.record(execution);

  const provider = {
    getStatus: async () => "confirmed" as const,
  };

  const reconciler = new TransactionStatusReconciler(store, provider, { intervalMs: 60000 });
  const result = await reconciler.reconcile();

  assert.equal(result.confirmed, 1);
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "confirmed");
  assert.equal(updated?.nextRetryAt, null);
});

// --- #276: retire over-age not_found executions stuck in submitted ---

// Fixed clock so age is deterministic: "now" is 2026-11-19T00:00:00Z and
// record ages are set relative to it via updatedAt (the age anchor:
// updatedAt is bumped on every transition into `submitted`).
const FIXED_NOW = new Date("2026-11-19T00:00:00.000Z");
const HOUR_MS = 60 * 60_000;

function makeAgedExecution(ageMs: number, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const at = new Date(FIXED_NOW.getTime() - ageMs).toISOString();
  return makeExecution({ createdAt: at, updatedAt: at, ...overrides });
}

function makeReservedDecision(): NonNullable<ExecutionRecord["policyDecision"]> {
  return {
    result: "allow",
    reason: "test",
    rule: "default",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
    reservedDailySpending: { asset: "XLM", amount: "10" },
  };
}

test("Reconciler #276: young not_found stays submitted", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(1 * HOUR_MS, { txHash: "tx-young" });
  await store.record(execution);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "submitted");
});

test("Reconciler #276: over-age not_found retires to failed with a clear error", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old" });
  await store.record(execution);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.retired, 1);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /not found on-chain after 6h/);
});

test("Reconciler #276: network_error never retires, even over-age", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-neterr" });
  await store.record(execution);

  const provider = { getStatus: async () => "network_error" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.failed, 0);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "submitted");
});

test("Reconciler #276: over-age confirmed still confirms (not retired)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old-confirmed" });
  await store.record(execution);

  const provider = { getStatus: async () => "confirmed" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.confirmed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "confirmed");
});

test("Reconciler #276: over-age on-chain failed still fails (not counted as retired)", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old-failed" });
  await store.record(execution);

  const provider = { getStatus: async () => "failed" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.failed, 1);
  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "failed");
});

test("Reconciler #276: max age is configurable via options", async () => {
  const store = new InMemoryExecutionStore();
  const justOver = makeAgedExecution(61_000, { txHash: "tx-61s" });
  const justUnder = makeAgedExecution(30_000, { txHash: "tx-30s" });
  await store.record(justOver);
  await store.record(justUnder);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    maxAgeMs: 60_000,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1);
  assert.equal((await store.get(justOver.id))?.status, "failed");
  assert.equal((await store.get(justUnder.id))?.status, "submitted");
});

test("Reconciler #276: unparseable updatedAt is treated as young, never retired", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ txHash: "tx-bad-ts", updatedAt: "not-a-date" });
  await store.record(execution);

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, { clock: () => FIXED_NOW });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 0);
  assert.equal((await store.get(execution.id))?.status, "submitted");
});

test("Reconciler #276: invalid maxAgeMs fails fast", async () => {
  const store = new InMemoryExecutionStore();
  const provider = { getStatus: async () => "not_found" as const };
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new TransactionStatusReconciler(store, provider, { maxAgeMs: bad }),
      /maxAgeMs/
    );
  }
});

test("Reconciler #276: retire releases the proven reservation exactly once", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, {
    txHash: "tx-retire-release",
    policyDecision: makeReservedDecision(),
  });
  await store.record(execution);

  const releases: Array<[string, string, string]> = [];
  const activityStore = {
    releaseDailySpending: async (agentId: string, asset: string, amount: string) => {
      releases.push([agentId, asset, amount]);
    },
  };

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    activityStore,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1);
  assert.deepEqual(releases, [["agent-a", "XLM", "10"]]);

  // Second pass: already failed, no longer submitted — no second release.
  const second = await reconciler.reconcile();
  assert.equal(second.checked, 0);
  assert.deepEqual(releases, [["agent-a", "XLM", "10"]]);
});

test("Reconciler #276: no release without proof of reservation, or when young", async () => {
  const store = new InMemoryExecutionStore();
  const oldNoProof = makeAgedExecution(7 * HOUR_MS, { txHash: "tx-old-noproof" });
  const youngWithProof = makeAgedExecution(1 * HOUR_MS, {
    txHash: "tx-young-proof",
    policyDecision: makeReservedDecision(),
  });
  await store.record(oldNoProof);
  await store.record(youngWithProof);

  const releases: Array<[string, string, string]> = [];
  const activityStore = {
    releaseDailySpending: async (agentId: string, asset: string, amount: string) => {
      releases.push([agentId, asset, amount]);
    },
  };

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    activityStore,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1); // only the old record without proof
  assert.deepEqual(releases, []);
});

test("Reconciler #276: a release failure never masks the retire", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeAgedExecution(7 * HOUR_MS, {
    txHash: "tx-release-fails",
    policyDecision: makeReservedDecision(),
  });
  await store.record(execution);

  const activityStore = {
    releaseDailySpending: async () => {
      throw new Error("store down");
    },
  };

  const provider = { getStatus: async () => "not_found" as const };
  const reconciler = new TransactionStatusReconciler(store, provider, {
    clock: () => FIXED_NOW,
    activityStore,
  });
  const result = await reconciler.reconcile();

  assert.equal(result.retired, 1);
  assert.equal((await store.get(execution.id))?.status, "failed");
});
