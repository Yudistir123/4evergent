import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAgentStore, SQLiteAgentStore, MAX_LIMIT } from "../src/agent-store.js";
import { closeSharedConnection } from "../src/shared-connection.js";
import type { CreateAgentInput } from "../src/agent-types.js";

function temporaryDatabasePath(): string {
  return join(tmpdir(), `4evergent-agent-store-${crypto.randomUUID()}.db`);
}

function removeTemporaryDatabase(dbPath: string): void {
  closeSharedConnection(dbPath);
  try {
    unlinkSync(dbPath);
  } catch {
    // The database file may not have been created if setup failed.
  }
}

function testStores(name: string, makeStore: () => InMemoryAgentStore | SQLiteAgentStore) {
  // createdAt has millisecond resolution, so agents created in a tight loop
  // can share a timestamp and sort ties keep insertion order. The offset
  // tests below space creates out so newest-first ordering is meaningful.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  test(`${name}: create and get`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const input: CreateAgentInput = { displayName: "Agent A", ownerId: "owner-a" };
      const agent = await store.create(input);
      assert.equal(agent.displayName, "Agent A");
      assert.equal(agent.status, "active");
      assert.equal(agent.active, true);
      assert.deepEqual(agent.capabilities, []);
      assert.equal(agent.description, "");
      assert.equal(agent.stellarAddress, "");
      assert.ok(agent.id);

      const fetched = await store.get(agent.id);
      assert.equal(fetched?.id, agent.id);
      assert.equal(fetched?.ownerId, "owner-a");
      assert.equal(fetched?.metadata !== undefined, true);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: create with full fields`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({
        displayName: "Full",
        description: "desc",
        capabilities: ["payment"],
        ownerId: "owner-b",
        stellarAddress: "GADDR",
        status: "paused",
      });
      assert.equal(agent.status, "paused");
      assert.equal(agent.active, false);
      assert.deepEqual(agent.capabilities, ["payment"]);
      assert.equal(agent.stellarAddress, "GADDR");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: create preserves explicit id`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({ id: "fixed-id", displayName: "Fixed", ownerId: "owner-a" });
      assert.equal(agent.id, "fixed-id");
      const fetched = await store.get("fixed-id");
      assert.equal(fetched?.displayName, "Fixed");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: getForOwner enforces owner`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({ displayName: "X", ownerId: "owner-a" });
      assert.ok(await store.getForOwner(agent.id, "owner-a"));
      assert.equal(await store.getForOwner(agent.id, "owner-b"), null);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner only returns owner records`, async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.create({ displayName: "A", ownerId: "owner-a" });
      await store.create({ displayName: "B", ownerId: "owner-b" });
      const list = await store.listByOwner("owner-a");
      assert.equal(list.length, 1);
      assert.equal(list[0]?.displayName, "A");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: update status`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
      const updated = await store.update(agent.id, { status: "paused" });
      assert.equal(updated?.status, "paused");
      assert.equal(updated?.active, false);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: concurrent status transitions use the current stored status`, async () => {
    const { store } = makeStore();
    const agent = await store.create({ displayName: "A", ownerId: "owner-a" });

    const [disabled, pause] = await Promise.all([
      store.transitionStatus(agent.id, "disabled"),
      store.transitionStatus(agent.id, "paused"),
    ]);

    assert.equal(disabled.updated, true);
    assert.deepEqual(pause, {
      updated: false,
      reason: "invalid_transition",
      currentStatus: "disabled",
    });
    assert.equal((await store.get(agent.id))?.status, "disabled");
  });

  test(`${name}: disabled agents cannot transition back to active`, async () => {
    const { store } = makeStore();
    const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
    await store.transitionStatus(agent.id, "disabled");

    const result = await store.transitionStatus(agent.id, "active");
    assert.deepEqual(result, {
      updated: false,
      reason: "invalid_transition",
      currentStatus: "disabled",
    });
    assert.equal((await store.get(agent.id))?.status, "disabled");
  });

  test(`${name}: delete removes record`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
      assert.equal(await store.delete(agent.id), true);
      assert.equal(await store.get(agent.id), null);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: concurrent status transitions use the current stored status`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({ displayName: "A", ownerId: "owner-a" });

      const [disabled, pause] = await Promise.all([
        store.transitionStatus(agent.id, "disabled"),
        store.transitionStatus(agent.id, "paused"),
      ]);

      assert.equal(disabled.updated, true);
      assert.deepEqual(pause, {
        updated: false,
        reason: "invalid_transition",
        currentStatus: "disabled",
      });
      assert.equal((await store.get(agent.id))?.status, "disabled");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: disabled agents cannot transition back to active`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const agent = await store.create({ displayName: "A", ownerId: "owner-a" });
      await store.transitionStatus(agent.id, "disabled");

      const result = await store.transitionStatus(agent.id, "active");
      assert.deepEqual(result, {
        updated: false,
        reason: "invalid_transition",
        currentStatus: "disabled",
      });
      assert.equal((await store.get(agent.id))?.status, "disabled");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability returns matching agents with full capability array`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const a1 = await store.create({
        displayName: "Payment and Trustline",
        ownerId: "owner-a",
        capabilities: ["payment", "trustline"],
      });
      await store.create({
        displayName: "Trustline only",
        ownerId: "owner-a",
        capabilities: ["trustline"],
      });
      const a3 = await store.create({
        displayName: "Payment only",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });

      const matched = await store.listByCapability("owner-a", "payment");
      assert.equal(matched.length, 2);
      const ids = matched.map((a) => a.id);
      assert.ok(ids.includes(a1.id));
      assert.ok(ids.includes(a3.id));

      const foundA1 = matched.find((a) => a.id === a1.id);
      assert.deepEqual(foundA1?.capabilities, ["payment", "trustline"]);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability exact match semantics (no substring or prefix)`, async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.create({
        displayName: "Payment Agent",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });

      // Substring/prefix "pay" must NOT match "payment"
      const prefixMatch = await store.listByCapability("owner-a", "pay");
      assert.deepEqual(prefixMatch, []);

      // Superstring "payment_batching" must NOT match "payment"
      const superMatch = await store.listByCapability("owner-a", "payment_batching");
      assert.deepEqual(superMatch, []);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability case sensitivity`, async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.create({
        displayName: "Payment Agent",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });

      const titleMatch = await store.listByCapability("owner-a", "Payment");
      assert.deepEqual(titleMatch, []);

      const upperMatch = await store.listByCapability("owner-a", "PAYMENT");
      assert.deepEqual(upperMatch, []);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability returns empty array on no-match (never null or error)`, async () => {
    const { store, cleanup } = makeStore();
    try {
      await store.create({
        displayName: "Payment Agent",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });

      const res = await store.listByCapability("owner-a", "nonexistent");
      assert.ok(Array.isArray(res));
      assert.equal(res.length, 0);

      const emptyRes = await store.listByCapability("owner-a", "");
      assert.ok(Array.isArray(emptyRes));
      assert.equal(emptyRes.length, 0);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability enforces owner isolation`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const a1 = await store.create({
        displayName: "Owner A Payment Agent",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });
      await store.create({
        displayName: "Owner B Payment Agent",
        ownerId: "owner-b",
        capabilities: ["payment"],
      });

      const ownerARes = await store.listByCapability("owner-a", "payment");
      assert.equal(ownerARes.length, 1);
      assert.equal(ownerARes[0].id, a1.id);
      assert.equal(ownerARes[0].ownerId, "owner-a");

      const ownerBRes = await store.listByCapability("owner-b", "payment");
      assert.equal(ownerBRes.length, 1);
      assert.equal(ownerBRes[0].ownerId, "owner-b");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability respects limit parameter`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({
          displayName: `Agent ${i}`,
          ownerId: "owner-a",
          capabilities: ["payment"],
        });
      }

      const res = await store.listByCapability("owner-a", "payment", 2);
      assert.equal(res.length, 2);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability executes in store beyond MAX_LIMIT (${MAX_LIMIT})`, async () => {
    const { store, cleanup } = makeStore();
    try {
      // Create 1 matching agent first (so it's the oldest)
      const target = await store.create({
        displayName: "Oldest Payment Agent",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });

      // Create MAX_LIMIT + 5 agents without payment capability
      for (let i = 0; i < MAX_LIMIT + 5; i++) {
        await store.create({
          displayName: `Filler Agent ${i}`,
          ownerId: "owner-a",
          capabilities: ["unrelated"],
        });
      }

      // If the query was executed by post-filtering a list capped at MAX_LIMIT,
      // the target agent would have been truncated before filtering.
      // Store-level filtering ensures target is found and returned.
      const res = await store.listByCapability("owner-a", "payment");
      assert.equal(res.length, 1);
      assert.equal(res[0].id, target.id);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner default limit is MAX_LIMIT (${MAX_LIMIT})`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({ displayName: `Agent ${i}`, ownerId: "owner-a" });
      }
      // Omitted limit → default MAX_LIMIT (200), so all 5 returned
      const list = await store.listByOwner("owner-a");
      assert.equal(list.length, 5);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner limit=0 clamps to 1`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({ displayName: `Agent ${i}`, ownerId: "owner-a" });
      }
      const list = await store.listByOwner("owner-a", 0);
      assert.equal(list.length, 1);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner limit exceeding MAX_LIMIT clamps to MAX_LIMIT`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({ displayName: `Agent ${i}`, ownerId: "owner-a" });
      }
      const list = await store.listByOwner("owner-a", 999);
      assert.equal(list.length, 5); // only 5 exist, all returned
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner negative limit clamps to 1`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({ displayName: `Agent ${i}`, ownerId: "owner-a" });
      }
      const list = await store.listByOwner("owner-a", -10);
      assert.equal(list.length, 1);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability limit=0 clamps to 1`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({
          displayName: `Agent ${i}`,
          ownerId: "owner-a",
          capabilities: ["payment"],
        });
      }
      const list = await store.listByCapability("owner-a", "payment", 0);
      assert.equal(list.length, 1);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability negative limit clamps to 1`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 5; i++) {
        await store.create({
          displayName: `Agent ${i}`,
          ownerId: "owner-a",
          capabilities: ["payment"],
        });
      }
      const list = await store.listByCapability("owner-a", "payment", -5);
      assert.equal(list.length, 1);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner offset walks pages without duplicates (#380)`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const created = [];
      for (let i = 0; i < 5; i++) {
        created.push(await store.create({ displayName: `Agent ${i}`, ownerId: "owner-a" }));
        await sleep(2);
      }
      // Newest-first: last created is first.
      const page1 = await store.listByOwner("owner-a", 2, 0);
      const page2 = await store.listByOwner("owner-a", 2, 2);
      const page3 = await store.listByOwner("owner-a", 2, 4);
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 2);
      assert.equal(page3.length, 1);
      assert.deepEqual(page1.map((a) => a.id), [created[4]!.id, created[3]!.id]);
      assert.deepEqual(page2.map((a) => a.id), [created[2]!.id, created[1]!.id]);
      assert.deepEqual(page3.map((a) => a.id), [created[0]!.id]);
      const allIds = [...page1, ...page2, ...page3].map((a) => a.id);
      assert.equal(new Set(allIds).size, 5, "no duplicate across pages");

      // Offset past the end returns an empty page, never an error.
      assert.deepEqual(await store.listByOwner("owner-a", 2, 5), []);
      assert.deepEqual(await store.listByOwner("owner-a", 2, 100), []);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByOwner negative offset clamps to 0`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push(await store.create({ displayName: `Agent ${i}`, ownerId: "owner-a" }));
        await sleep(2);
      }
      const list = await store.listByOwner("owner-a", 2, -5);
      assert.deepEqual(list.map((a) => a.id), [created[2]!.id, created[1]!.id]);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: listByCapability offset applies after the capability filter (#380)`, async () => {
    const { store, cleanup } = makeStore();
    try {
      const payment = [];
      for (let i = 0; i < 5; i++) {
        payment.push(
          await store.create({ displayName: `Pay ${i}`, ownerId: "owner-a", capabilities: ["payment"] })
        );
        await sleep(2);
      }
      // Non-matching agents interleaved: offset must skip matching agents
      // only, not rows of the unfiltered list.
      await store.create({ displayName: "Other 1", ownerId: "owner-a", capabilities: ["trustline"] });
      await store.create({ displayName: "Other 2", ownerId: "owner-a", capabilities: ["trustline"] });

      const page1 = await store.listByCapability("owner-a", "payment", 2, 0);
      const page2 = await store.listByCapability("owner-a", "payment", 2, 2);
      const page3 = await store.listByCapability("owner-a", "payment", 2, 4);
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 2);
      assert.equal(page3.length, 1);
      assert.deepEqual(page1.map((a) => a.id), [payment[4]!.id, payment[3]!.id]);
      assert.deepEqual(page2.map((a) => a.id), [payment[2]!.id, payment[1]!.id]);
      assert.deepEqual(page3.map((a) => a.id), [payment[0]!.id]);
      const allIds = [...page1, ...page2, ...page3].map((a) => a.id);
      assert.equal(new Set(allIds).size, 5, "no duplicate across pages");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: countByOwner and countByCapability ignore limit/offset`, async () => {
    const { store, cleanup } = makeStore();
    try {
      for (let i = 0; i < 3; i++) {
        await store.create({ displayName: `Pay ${i}`, ownerId: "owner-a", capabilities: ["payment"] });
      }
      await store.create({ displayName: "Other", ownerId: "owner-a", capabilities: ["trustline"] });
      await store.create({ displayName: "Foreign", ownerId: "owner-b", capabilities: ["payment"] });
      assert.equal(await store.countByOwner("owner-a"), 4);
      assert.equal(await store.countByOwner("owner-b"), 1);
      assert.equal(await store.countByOwner("owner-none"), 0);
      assert.equal(await store.countByCapability("owner-a", "payment"), 3);
      assert.equal(await store.countByCapability("owner-a", "trustline"), 1);
      assert.equal(await store.countByCapability("owner-a", "missing"), 0);
      assert.equal(await store.countByCapability("owner-b", "payment"), 1);
    } finally {
      cleanup?.();
    }
  });
}

testStores("InMemoryAgentStore", () => ({
  store: new InMemoryAgentStore(),
}));

testStores("SQLiteAgentStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-agent-test-"));
  const path = join(dir, "agent-test.db");
  const store = new SQLiteAgentStore(path);
  return {
    store,
    cleanup: () => {
      closeSharedConnection(path);
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

test("SQLiteAgentStore: persistence across instances", async () => {
  const dbPath = temporaryDatabasePath();
  try {
    const store1 = new SQLiteAgentStore(dbPath);
    const created = await store1.create({ displayName: "Persisted", ownerId: "owner-a", capabilities: ["payment"] });
    closeSharedConnection(dbPath);

    const store2 = new SQLiteAgentStore(dbPath);
    const fetched = await store2.get(created.id);
    assert.ok(fetched);
    assert.equal(fetched.displayName, "Persisted");
    assert.equal(fetched.ownerId, "owner-a");
    assert.equal(fetched.status, "active");
    assert.deepEqual(fetched.capabilities, ["payment"]);

    const byCap = await store2.listByCapability("owner-a", "payment");
    assert.equal(byCap.length, 1);
    assert.equal(byCap[0].id, created.id);
    store2.close();
  } finally {
    removeTemporaryDatabase(dbPath);
  }
});

test("SQLiteAgentStore: concurrent status transitions use the current stored status", async () => {
  const dbPath = temporaryDatabasePath();
  try {
    const store = new SQLiteAgentStore(dbPath);
    const agent = await store.create({ displayName: "Concurrent", ownerId: "owner-a" });

    const [disabled, pause] = await Promise.all([
      store.transitionStatus(agent.id, "disabled"),
      store.transitionStatus(agent.id, "paused"),
    ]);

    assert.equal(disabled.updated, true);
    assert.deepEqual(pause, {
      updated: false,
      reason: "invalid_transition",
      currentStatus: "disabled",
    });
    assert.equal((await store.get(agent.id))?.status, "disabled");
  } finally {
    removeTemporaryDatabase(dbPath);
  }
});
