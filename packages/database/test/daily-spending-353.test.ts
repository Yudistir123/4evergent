import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  InMemoryActivityStore,
  SQLiteActivityStore,
  type ActivityStore,
} from "../src/index.js";

// #353: SQLite and InMemory MUST behave identically for daily spending.
// - An over-limit FIRST reservation returns false and persists NO row, so a
//   later in-limit reservation for the same asset still succeeds.
// - releaseDailySpending decrements the day's total and floors at 0.

function makeStore(name: "InMemory" | "SQLite"): { store: ActivityStore; cleanup: () => void } {
  if (name === "InMemory") {
    return { store: new InMemoryActivityStore(), cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "spending-353-"));
  const store = new SQLiteActivityStore(join(tmp, "test.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const BACKENDS = ["InMemory", "SQLite"] as const;

for (const backend of BACKENDS) {
  test(`#353 [${backend}] over-limit first reservation returns false and persists no row`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "600", "500"), false);
      // No row: getDailySpending is null (not an over-limit total).
      assert.equal(await store.getDailySpending("a1", "XLM"), null);
      // The asset is NOT bricked: an in-limit reservation still succeeds.
      assert.equal(await store.reserveDailySpending("a1", "XLM", "300", "500"), true);
      assert.equal(await store.getDailySpending("a1", "XLM"), 300);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] over-limit first reservation exactly at limit+1 then full-limit succeeds`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "501", "500"), false);
      assert.equal(await store.getDailySpending("a1", "XLM"), null);
      assert.equal(await store.reserveDailySpending("a1", "XLM", "500", "500"), true);
      assert.equal(await store.getDailySpending("a1", "XLM"), 500);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] releaseDailySpending decrements and frees the limit`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "300", "500"), true);
      assert.equal(await store.getDailySpending("a1", "XLM"), 300);
      await store.releaseDailySpending("a1", "XLM", "300");
      assert.equal((await store.getDailySpending("a1", "XLM")) ?? 0, 0);
      // Freed amount can be reserved again.
      assert.equal(await store.reserveDailySpending("a1", "XLM", "500", "500"), true);
      assert.equal(await store.getDailySpending("a1", "XLM"), 500);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] release is partial and floors at zero`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "200", "500"), true);
      await store.releaseDailySpending("a1", "XLM", "50");
      assert.equal(await store.getDailySpending("a1", "XLM"), 150);
      // Releasing more than reserved must not go negative.
      await store.releaseDailySpending("a1", "XLM", "999");
      assert.equal((await store.getDailySpending("a1", "XLM")) ?? 0, 0);
      // Releasing with nothing reserved is a no-op, not an error.
      await store.releaseDailySpending("a1", "XLM", "10");
      assert.equal((await store.getDailySpending("a1", "XLM")) ?? 0, 0);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] release is scoped per agent/asset`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      assert.equal(await store.reserveDailySpending("a1", "XLM", "100", "500"), true);
      assert.equal(await store.reserveDailySpending("a1", "USDC", "100", "500"), true);
      assert.equal(await store.reserveDailySpending("a2", "XLM", "100", "500"), true);
      await store.releaseDailySpending("a1", "XLM", "100");
      assert.equal((await store.getDailySpending("a1", "XLM")) ?? 0, 0);
      assert.equal(await store.getDailySpending("a1", "USDC"), 100);
      assert.equal(await store.getDailySpending("a2", "XLM"), 100);
    } finally {
      cleanup();
    }
  });
}
