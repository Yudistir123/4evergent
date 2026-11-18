import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryExecutionStore, SQLiteExecutionStore } from "../src/execution-store.js";
import { closeAllSharedConnections } from "../src/shared-connection.js";
import type { ExecutionRecord, ExecutionStore, ExecutionStatus } from "../src/execution-types.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "execution-store-test-"));
  tmpDirs.push(dir);
  return dir;
}

function cleanup(): void {
  closeAllSharedConnections();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "test execution",
    } as unknown as ExecutionRecord["intent"],
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    submittedHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface Harness {
  name: string;
  create: () => ExecutionStore;
}

/**
 * Every test below that is not explicitly SQLite-only runs against BOTH stores.
 * The queue's safety properties are defined by the ExecutionStore contract, so
 * the durable implementation must not drift from the in-memory reference.
 */
const harnesses: Harness[] = [
  { name: "InMemory", create: () => new InMemoryExecutionStore() },
  {
    name: "SQLite",
    create: () => new SQLiteExecutionStore(join(makeTmpDir(), "executions.db")),
  },
];

for (const harness of harnesses) {
  test(`${harness.name}: round-trips every persisted field`, async () => {
    const store = harness.create();
    const record = makeRecord({
      approvalId: "approval-1",
      activityId: "activity-1",
      submittedHash: "hash-1",
      txHash: "tx-1",
      attempt: 2,
      error: "boom",
      errorClass: "transient",
      nextRetryAt: "2026-01-01T00:00:10.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:20.000Z",
    });
    await store.record(record);

    const loaded = await store.get(record.id);
    assert.deepEqual(loaded, record);
  });

  test(`${harness.name}: getForOwner is owner-scoped`, async () => {
    const store = harness.create();
    const record = makeRecord({ ownerId: "owner-a" });
    await store.record(record);

    assert.ok(await store.getForOwner(record.id, "owner-a"));
    assert.equal(await store.getForOwner(record.id, "owner-b"), null);
    assert.equal(await store.getForOwner("missing", "owner-a"), null);
  });

  test(`${harness.name}: update merges the patch and preserves unpatched columns`, async () => {
    const store = harness.create();
    const record = makeRecord({ txHash: "keep-me", attempt: 2 });
    await store.record(record);

    const updated = await store.update(record.id, { status: "confirmed", updatedAt: "2026-01-01T00:00:30.000Z" });
    assert.equal(updated?.status, "confirmed");
    assert.equal(updated?.txHash, "keep-me");
    assert.equal(updated?.attempt, 2);
    assert.equal(updated?.ownerId, "owner-a");

    const reloaded = await store.get(record.id);
    assert.equal(reloaded?.status, "confirmed");
    assert.equal(reloaded?.txHash, "keep-me");
    assert.equal(reloaded?.attempt, 2);
  });

  test(`${harness.name}: update can clear nullable columns explicitly`, async () => {
    const store = harness.create();
    const record = makeRecord({ txHash: "tx-1", error: "boom", errorClass: "transient" });
    await store.record(record);

    const updated = await store.update(record.id, { txHash: null, error: null, errorClass: null });
    assert.equal(updated?.txHash, null);
    assert.equal(updated?.error, null);
    assert.equal(updated?.errorClass, null);
  });

  test(`${harness.name}: update returns null for an unknown id`, async () => {
    const store = harness.create();
    assert.equal(await store.update("missing", { status: "confirmed" }), null);
  });

  test(`${harness.name}: an empty patch is a no-op that still checks existence`, async () => {
    const store = harness.create();
    const record = makeRecord({ status: "queued" });
    await store.record(record);

    const unchanged = await store.update(record.id, {});
    assert.equal(unchanged?.status, "queued");
    assert.equal(await store.update("missing", {}), null);

    const casHit = await store.updateIfStatus(record.id, "queued", {});
    assert.equal(casHit?.id, record.id);
    assert.equal(await store.updateIfStatus(record.id, "submitted", {}), null);
  });

  test(`${harness.name}: updateIfStatus rejects a mismatched expected status`, async () => {
    const store = harness.create();
    const record = makeRecord({ status: "queued" });
    await store.record(record);

    const result = await store.updateIfStatus(record.id, "submitted", { status: "confirmed" });
    assert.equal(result, null);
    assert.equal((await store.get(record.id))?.status, "queued");
  });

  test(`${harness.name}: updateIfStatus returns null for an unknown id`, async () => {
    const store = harness.create();
    assert.equal(await store.updateIfStatus("missing", "queued", { status: "executing" }), null);
  });

  test(`${harness.name}: concurrent claim has exactly one winner`, async () => {
    const store = harness.create();
    const record = makeRecord({ status: "queued" });
    await store.record(record);

    const claims = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        store.updateIfStatus(record.id, "queued", {
          status: "executing",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: `worker-${index}`,
        })
      )
    );

    const winners = claims.filter((claim) => claim !== null);
    assert.equal(winners.length, 1, "exactly one worker may claim a queued execution");
    assert.equal((await store.get(record.id))?.status, "executing");
  });

  test(`${harness.name}: a second claim of an executing record loses`, async () => {
    const store = harness.create();
    const record = makeRecord({ status: "queued" });
    await store.record(record);

    const first = await store.updateIfStatus(record.id, "queued", { status: "executing" });
    const second = await store.updateIfStatus(record.id, "queued", { status: "executing" });
    assert.ok(first);
    assert.equal(second, null);
  });

  test(`${harness.name}: listDue gates queued and failed records by nextRetryAt`, async () => {
    const store = harness.create();
    const now = "2026-01-01T00:00:10.000Z";
    await store.record(makeRecord({ id: "queued-now", status: "queued", nextRetryAt: null }));
    await store.record(makeRecord({ id: "queued-later", status: "queued", nextRetryAt: "2026-01-01T00:00:20.000Z" }));
    await store.record(makeRecord({ id: "failed-due", status: "failed", nextRetryAt: "2026-01-01T00:00:05.000Z" }));
    await store.record(makeRecord({ id: "failed-later", status: "failed", nextRetryAt: "2026-01-01T00:01:00.000Z" }));
    await store.record(makeRecord({ id: "executing", status: "executing" }));
    await store.record(makeRecord({ id: "submitted", status: "submitted", txHash: "tx" }));
    await store.record(makeRecord({ id: "confirmed", status: "confirmed", txHash: "tx" }));
    await store.record(makeRecord({ id: "dead-letter", status: "dead_letter" }));

    const due = (await store.listDue(now)).map((r) => r.id).sort();
    assert.deepEqual(due, ["failed-due", "queued-now"]);
  });

  test(`${harness.name}: listDue never picks up reconciler-failed records (#378)`, async () => {
    const store = harness.create();
    const now = "2026-01-01T00:00:10.000Z";
    // Reconciler-failed: terminal on-chain outcome. No scheduled retry
    // (nextRetryAt null), or a stale already-past one left over from an
    // earlier attempt — either way the queue must never re-execute it.
    // Both variants carry the on-chain submission hash.
    await store.record(makeRecord({ id: "reconciler-failed-null", status: "failed", submittedHash: "onchain-hash", txHash: "onchain-hash", error: "Transaction failed on-chain", nextRetryAt: null }));
    await store.record(makeRecord({ id: "reconciler-failed-stale", status: "failed", submittedHash: "onchain-hash", txHash: "onchain-hash", error: "Transaction failed on-chain", nextRetryAt: "2026-01-01T00:00:05.000Z" }));
    // Queue-failed: retryable failure with a scheduled retry, no submission.
    await store.record(makeRecord({ id: "queue-failed-due", status: "failed", submittedHash: null, txHash: null, nextRetryAt: "2026-01-01T00:00:05.000Z" }));
    await store.record(makeRecord({ id: "queue-failed-later", status: "failed", submittedHash: null, txHash: null, nextRetryAt: "2026-01-01T00:01:00.000Z" }));
    await store.record(makeRecord({ id: "queued", status: "queued", nextRetryAt: null }));

    const due = (await store.listDue(now)).map((r) => r.id).sort();
    assert.deepEqual(due, ["queue-failed-due", "queued"]);
  });

  test(`${harness.name}: listDue returns the earliest retry first`, async () => {
    const store = harness.create();
    await store.record(makeRecord({ id: "third", status: "failed", nextRetryAt: "2026-01-01T00:00:09.000Z" }));
    await store.record(makeRecord({ id: "first", status: "failed", nextRetryAt: "2026-01-01T00:00:01.000Z" }));
    await store.record(makeRecord({ id: "second", status: "failed", nextRetryAt: "2026-01-01T00:00:05.000Z" }));

    const due = (await store.listDue("2026-01-01T00:00:10.000Z")).map((r) => r.id);
    assert.deepEqual(due, ["first", "second", "third"]);
  });

  test(`${harness.name}: retry/backoff state machine ends in dead_letter`, async () => {
    const store = harness.create();
    const record = makeRecord({ status: "queued" });
    await store.record(record);

    const maxRetries = 3;
    let attempt = 0;
    let nextRetryAt = new Date(Date.now() + 60_000).toISOString();
    let status: ExecutionRecord["status"] = "queued";

    for (let round = 0; round < maxRetries; round++) {
      // claim: queued/failed → executing (only while retries remain)
      const claimed = await store.updateIfStatus(record.id, status, { status: "executing" });
      assert.ok(claimed, `round ${round} should claim`);

      // pipeline failure → attempt++, then retry or dead_letter
      attempt += 1;
      const afterFailure = await store.update(record.id, { attempt, status: "failed", nextRetryAt });
      assert.equal(afterFailure?.attempt, attempt);

      const dueBefore = await store.listDue(new Date(Date.parse(nextRetryAt) - 1).toISOString());
      assert.equal(dueBefore.some((r) => r.id === record.id), false, "must not be due before backoff elapses");

      const dueAfter = await store.listDue(nextRetryAt);
      assert.equal(dueAfter.some((r) => r.id === record.id), true, "must be due once backoff elapses");

      // back off further; last failure exhausts the budget
      attempt += 0;
      nextRetryAt = new Date(Date.parse(nextRetryAt) + 60_000).toISOString();
      status = "failed";

      if (attempt >= maxRetries) {
        const dead = await store.update(record.id, { status: "dead_letter", nextRetryAt: null });
        assert.equal(dead?.status, "dead_letter");
      }
    }

    const final = await store.get(record.id);
    assert.equal(final?.status, "dead_letter");
    assert.equal(final?.attempt, maxRetries);
    assert.equal(final?.nextRetryAt, null);

    const farFuture = await store.listDue("2099-01-01T00:00:00.000Z");
    assert.equal(farFuture.some((r) => r.id === record.id), false, "dead_letter is terminal");
  });

  test(`${harness.name}: listStuckExecuting and listSubmitted return oldest-first`, async () => {
    const store = harness.create();
    await store.record(makeRecord({ id: "exec-new", status: "executing", createdAt: "2026-01-01T00:00:20.000Z" }));
    await store.record(makeRecord({ id: "exec-old", status: "executing", createdAt: "2026-01-01T00:00:10.000Z" }));
    await store.record(makeRecord({ id: "sub-old", status: "submitted", txHash: "tx", createdAt: "2026-01-01T00:00:01.000Z" }));
    await store.record(makeRecord({ id: "sub-new", status: "submitted", txHash: "tx", createdAt: "2026-01-01T00:00:02.000Z" }));

    assert.deepEqual((await store.listStuckExecuting()).map((r) => r.id), ["exec-old", "exec-new"]);
    assert.deepEqual((await store.listSubmitted()).map((r) => r.id), ["sub-old", "sub-new"]);
  });

  test(`${harness.name}: countByOwner groups statuses and ignores other owners`, async () => {
    const store = harness.create();
    await store.record(makeRecord({ ownerId: "owner-a", status: "queued" }));
    await store.record(makeRecord({ ownerId: "owner-a", status: "queued" }));
    await store.record(makeRecord({ ownerId: "owner-a", status: "dead_letter" }));
    await store.record(makeRecord({ ownerId: "owner-b", status: "confirmed" }));

    const counts = await store.countByOwner("owner-a");
    assert.deepEqual(counts, {
      queued: 2,
      executing: 0,
      submitted: 0,
      confirmed: 0,
      failed: 0,
      dead_letter: 1,
      cancelled: 0,
    });
  });

  test(`${harness.name}: records and reads cancelled execution`, async () => {
    const store = harness.create();
    const now = new Date().toISOString();
    const rec = makeRecord({
      status: "cancelled",
      completedAt: now,
      error: "cancelled by user",
    });
    await store.record(rec);

    const got = await store.get(rec.id);
    assert.ok(got);
    assert.equal(got.id, rec.id);
    assert.equal(got.status, "cancelled");
    assert.equal(got.error, "cancelled by user");
    assert.equal(got.completedAt, now);

    const gotForOwner = await store.getForOwner(rec.id, "owner-a");
    assert.ok(gotForOwner);
    assert.equal(gotForOwner.status, "cancelled");
  });

  test(`${harness.name}: countByOwner tracks cancelled status separately from dead_letter and failed`, async () => {
    const store = harness.create();
    const statuses: ExecutionStatus[] = [
      "queued",
      "executing",
      "submitted",
      "confirmed",
      "failed",
      "dead_letter",
      "cancelled",
    ];
    for (const s of statuses) {
      await store.record(makeRecord({ id: `exec-${s}`, status: s, ownerId: "owner-count" }));
    }
    // Also record an execution for another owner to ensure owner isolation
    await store.record(makeRecord({ id: "exec-other", status: "cancelled", ownerId: "owner-other" }));

    const counts = await store.countByOwner("owner-count");
    assert.deepEqual(counts, {
      queued: 1,
      executing: 1,
      submitted: 1,
      confirmed: 1,
      failed: 1,
      dead_letter: 1,
      cancelled: 1,
    });

    const otherCounts = await store.countByOwner("owner-other");
    assert.equal(otherCounts.cancelled, 1);
    assert.equal(otherCounts.dead_letter, 0);
  });

  test(`${harness.name}: updateIfStatus atomically transitions queued and executing to cancelled`, async () => {
    const store = harness.create();
    const queuedRec = makeRecord({ status: "queued" });
    const executingRec = makeRecord({ status: "executing" });
    await store.record(queuedRec);
    await store.record(executingRec);

    const now = new Date().toISOString();

    // Transition queued → cancelled
    const updatedQueued = await store.updateIfStatus(queuedRec.id, "queued", {
      status: "cancelled",
      error: "cancelled by user",
      completedAt: now,
    });
    assert.ok(updatedQueued);
    assert.equal(updatedQueued.status, "cancelled");
    assert.equal(updatedQueued.error, "cancelled by user");

    // Transition executing → cancelled
    const updatedExecuting = await store.updateIfStatus(executingRec.id, "executing", {
      status: "cancelled",
      error: "cancelled by user",
      completedAt: now,
    });
    assert.ok(updatedExecuting);
    assert.equal(updatedExecuting.status, "cancelled");
    assert.equal(updatedExecuting.error, "cancelled by user");

    // Race guard: updateIfStatus fails if expected status does not match current status
    const mismatch = await store.updateIfStatus(queuedRec.id, "queued", {
      status: "dead_letter",
    });
    assert.equal(mismatch, null);
  });

  test(`${harness.name}: migration note verification — historical dead_letter records with error 'cancelled by user' are preserved`, async () => {
    const store = harness.create();
    const historicalRec = makeRecord({
      status: "dead_letter",
      error: "cancelled by user",
      completedAt: "2025-12-01T00:00:00.000Z",
    });
    await store.record(historicalRec);

    const got = await store.get(historicalRec.id);
    assert.ok(got);
    assert.equal(got.status, "dead_letter");
    assert.equal(got.error, "cancelled by user");

    const counts = await store.countByOwner("owner-a");
    assert.equal(counts.dead_letter, 1);
    assert.equal(counts.cancelled, 0);
  });

  test(`${harness.name}: listByOwner/listByAgent paginate newest-first`, async () => {
    const store = harness.create();
    for (let i = 0; i < 5; i++) {
      await store.record(
        makeRecord({
          id: `e${i}`,
          ownerId: "owner-a",
          agentId: "agent-a",
          updatedAt: `2026-01-01T00:00:0${i}.000Z`,
        })
      );
    }
    await store.record(
      makeRecord({ id: "other-owner", ownerId: "owner-b", agentId: "agent-b", updatedAt: "2026-01-01T00:00:09.000Z" })
    );
    await store.record(
      makeRecord({ id: "other-agent", ownerId: "owner-c", agentId: "agent-b", updatedAt: "2026-01-01T00:00:08.000Z" })
    );

    assert.deepEqual((await store.listByOwner("owner-a", 2, 0)).map((r) => r.id), ["e4", "e3"]);
    assert.deepEqual((await store.listByOwner("owner-a", 2, 2)).map((r) => r.id), ["e2", "e1"]);
    assert.deepEqual((await store.listByAgent("agent-a", 3, 0)).map((r) => r.id), ["e4", "e3", "e2"]);
  });

  test(`${harness.name}: delete reports whether a row was removed`, async () => {
    const store = harness.create();
    const record = makeRecord();
    await store.record(record);

    assert.equal(await store.delete(record.id), true);
    assert.equal(await store.delete(record.id), false);
    assert.equal(await store.get(record.id), null);
  });
}

test("SQLite: records survive a process-style reconnect", async () => {
  const dbPath = join(makeTmpDir(), "durable.db");
  const first = new SQLiteExecutionStore(dbPath);
  const record = makeRecord({
    id: "durable-1",
    status: "failed",
    attempt: 2,
    errorClass: "transient",
    nextRetryAt: "2026-01-01T00:05:00.000Z",
    // #378: a queue-failed record carries no submission hash — fail() never
    // persists one. A failed record WITH a submittedHash is a terminal
    // on-chain outcome (reconciler-failed) and listDue never picks it up,
    // so this reconnect test seeds the retryable shape (hash null).
    submittedHash: null,
  });
  await first.record(record);

  // Simulates the process exiting: the shared connection is closed and a new
  // store instance re-opens the same file (no shared in-process state).
  closeAllSharedConnections();
  const second = new SQLiteExecutionStore(dbPath);

  assert.deepEqual(await second.get(record.id), record);
  const due = await second.listDue("2026-01-01T00:05:00.000Z");
  assert.deepEqual(due.map((r) => r.id), ["durable-1"]);
  cleanup();
});

test("SQLite: updateIfStatus does not revert columns written concurrently", async () => {
  const dbPath = join(makeTmpDir(), "no-clobber.db");
  const store = new SQLiteExecutionStore(dbPath);
  await store.record(makeRecord({ id: "race", status: "executing" }));

  // Simulate another process landing a write between this store's read and
  // write. The earlier read-modify-write implementation restored `attempt` and
  // `submittedHash` from the stale snapshot, silently rolling back the retry
  // counter and the submission marker of an in-flight execution.
  const originalGet = store.get.bind(store);
  const originalUpdate = store.update.bind(store);
  let injected = false;
  (store as unknown as { get: typeof originalGet }).get = async (id: string) => {
    const snapshot = await originalGet(id);
    if (!injected) {
      injected = true;
      await originalUpdate(id, { attempt: 7, submittedHash: "submitted-hash" });
    }
    return snapshot;
  };

  const claimed = await store.updateIfStatus("race", "executing", {
    status: "submitted",
    txHash: "tx-1",
  });
  (store as unknown as { get: typeof originalGet }).get = originalGet;

  assert.equal(claimed?.status, "submitted");
  const final = await store.get("race");
  assert.equal(final?.status, "submitted");
  assert.equal(final?.txHash, "tx-1");
  assert.equal(final?.attempt, 7, "concurrent attempt increment must not be rolled back");
  assert.equal(final?.submittedHash, "submitted-hash", "concurrent submittedHash must not be lost");
  cleanup();
});

test("SQLite: listDue compares retry timestamps by instant, not by string shape", async () => {
  const store = new SQLiteExecutionStore(join(makeTmpDir(), "timestamps.db"));
  // 13:00+01:00 is 12:00Z — the same instant as the cutoff below.
  await store.record(makeRecord({ id: "offset", status: "failed", nextRetryAt: "2026-10-17T13:00:00+01:00" }));

  const before = await store.listDue("2026-10-17T11:59:59.999Z");
  assert.equal(before.some((r) => r.id === "offset"), false, "must not be due early");

  const at = await store.listDue("2026-10-17T12:00:00.000Z");
  assert.equal(at.some((r) => r.id === "offset"), true, "must be due at the instant");
  cleanup();
});

test("SQLite: migrates a pre-submittedHash executions table", async () => {
  const dbPath = join(makeTmpDir(), "legacy.db");
  // Old schema: executions table without submitted_hash.
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE executions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      approval_id TEXT,
      activity_id TEXT,
      intent_json TEXT NOT NULL,
      status TEXT NOT NULL,
      policy_decision_json TEXT,
      simulation_result_json TEXT,
      tx_hash TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      error_class TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      `INSERT INTO executions (id, owner_id, agent_id, intent_json, status, created_at, updated_at)
       VALUES ('legacy-1', 'owner-a', 'agent-a', ?, 'failed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .run(JSON.stringify(makeRecord().intent));
  legacy.close();

  const store = new SQLiteExecutionStore(dbPath);
  const migrated = await store.get("legacy-1");
  assert.ok(migrated);
  assert.equal(migrated?.status, "failed");
  assert.equal(migrated?.submittedHash, null);

  // The new column is writable after the migration.
  const updated = await store.updateIfStatus("legacy-1", "failed", { submittedHash: "new-hash" });
  assert.equal(updated?.submittedHash, "new-hash");
  cleanup();
});

test("SQLite: duplicate ids are rejected instead of silently overwriting in-flight state", async () => {
  const store = new SQLiteExecutionStore(join(makeTmpDir(), "duplicate.db"));
  const record = makeRecord({ id: "dup", status: "queued" });
  await store.record(record);

  await store.update(record.id, { status: "submitted", txHash: "tx-1" });
  await assert.rejects(
    () => store.record(makeRecord({ id: "dup", status: "queued" })),
    /UNIQUE constraint failed/
  );
  assert.equal((await store.get("dup"))?.status, "submitted");
  cleanup();
});

test.after(() => cleanup());
