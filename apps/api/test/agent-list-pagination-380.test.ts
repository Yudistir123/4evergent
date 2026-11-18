import { test } from "node:test";
import assert from "node:assert/strict";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";

// Offline test: in-process HTTP server + in-memory stores. No network access.
// Regression tests for issue #380 — GET /agents must be paginable past the
// first 200 agents: ?offset=, hasMore and total in the response.

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const OWNER = "test"; // DevAuthProvider defaultOwnerId below

async function startServer() {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: new DevAuthProvider({ defaultOwnerId: OWNER }),
  });

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    agentStore: typeof server.agentStore;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        agentStore: server.agentStore,
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedAgents(
  agentStore: { create: (input: any) => Promise<any> },
  count: number,
  opts: { capabilities?: string[]; spaced?: boolean } = {},
) {
  const created = [];
  for (let i = 0; i < count; i++) {
    created.push(
      await agentStore.create({
        displayName: `Agent ${i}`,
        ownerId: OWNER,
        capabilities: opts.capabilities ?? [],
      }),
    );
    // createdAt has millisecond resolution; space creates out so
    // newest-first ordering is deterministic in the paging tests.
    if (opts.spaced) await sleep(2);
  }
  return created;
}

test("agents: 201 agents, first page of 200 reports hasMore and total 201", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    await seedAgents(agentStore, 201);

    const res = await get(baseUrl, "/agents?limit=200");
    assert.equal(res.status, 200);
    assert.equal(res.body.agents.length, 200);
    assert.equal(res.body.total, 201);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.hasMore, true);
  } finally {
    await close();
  }
});

test("agents: 201 agents, offset=200 returns the remaining agent", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    await seedAgents(agentStore, 201);

    const page1 = await get(baseUrl, "/agents?limit=200");
    const page2 = await get(baseUrl, "/agents?limit=200&offset=200");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.agents.length, 1);
    assert.equal(page2.body.total, 201);
    assert.equal(page2.body.truncated, false);
    assert.equal(page2.body.hasMore, false);
    // The second page holds exactly the agent the first page did not.
    // (Exact identity is not asserted here: 201 agents seeded in a tight
    // loop share createdAt milliseconds, so ties have no defined order.
    // Newest-first ordering is pinned by the spaced 4-agent test below.)
    const page1Ids = new Set(page1.body.agents.map((a: any) => a.id));
    assert.equal(page1Ids.has(page2.body.agents[0].id), false);
  } finally {
    await close();
  }
});

test("agents: default page (no params) reports truncation past 200", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    await seedAgents(agentStore, 201);

    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.equal(res.body.agents.length, 200);
    assert.equal(res.body.total, 201);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.hasMore, true);
  } finally {
    await close();
  }
});

test("agents: limit=2&offset=2 returns the 3rd and 4th agents, newest-first, no duplicates", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    const created = await seedAgents(agentStore, 4, { spaced: true });

    const page1 = await get(baseUrl, "/agents?limit=2&offset=0");
    const page2 = await get(baseUrl, "/agents?limit=2&offset=2");
    assert.equal(page1.body.agents.length, 2);
    assert.equal(page2.body.agents.length, 2);
    assert.deepEqual(
      page1.body.agents.map((a: any) => a.id),
      [created[3]!.id, created[2]!.id],
    );
    assert.deepEqual(
      page2.body.agents.map((a: any) => a.id),
      [created[1]!.id, created[0]!.id],
    );
    assert.equal(page2.body.total, 4);
    assert.equal(page2.body.hasMore, false);
    assert.equal(page2.body.truncated, false);
    const allIds = [...page1.body.agents, ...page2.body.agents].map((a: any) => a.id);
    assert.equal(new Set(allIds).size, 4, "no duplicate across pages");
  } finally {
    await close();
  }
});

test("agents: small owner is not truncated", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    await seedAgents(agentStore, 3);

    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.equal(res.body.agents.length, 3);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.truncated, false);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("agents: offset applies after the capability filter, total counts matches only", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    await seedAgents(agentStore, 4, { capabilities: ["payment"], spaced: true });
    await seedAgents(agentStore, 2, { capabilities: ["trustline"] });

    const page1 = await get(baseUrl, "/agents?capability=payment&limit=2&offset=0");
    assert.equal(page1.body.agents.length, 2);
    assert.equal(page1.body.total, 4);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents?capability=payment&limit=2&offset=2");
    assert.equal(page2.body.agents.length, 2);
    assert.equal(page2.body.total, 4);
    assert.equal(page2.body.hasMore, false);
    assert.equal(page2.body.truncated, false);
    const allIds = [...page1.body.agents, ...page2.body.agents].map((a: any) => a.id);
    assert.equal(new Set(allIds).size, 4, "no duplicate across pages");
    assert.ok(page2.body.agents.every((a: any) => a.capabilities.includes("payment")));
  } finally {
    await close();
  }
});

test("agents: invalid offset returns 400 VALIDATION_ERROR (same as limit)", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    await seedAgents(agentStore, 2);

    for (const bad of ["abc", "1.5", ""]) {
      const res = await get(baseUrl, `/agents?offset=${bad}`);
      assert.equal(res.status, 400, `offset=${JSON.stringify(bad)}`);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.includes("integer"));
    }

    const resCap = await get(baseUrl, "/agents?capability=payment&offset=2.7");
    assert.equal(resCap.status, 400);
    assert.equal(resCap.body.code, "VALIDATION_ERROR");
  } finally {
    await close();
  }
});

test("agents: negative offset clamps to 0, offset past MAX_OFFSET ends pagination", async () => {
  const { baseUrl, close, agentStore } = await startServer();
  try {
    const created = await seedAgents(agentStore, 3, { spaced: true });

    const neg = await get(baseUrl, "/agents?limit=2&offset=-5");
    assert.equal(neg.status, 200);
    assert.deepEqual(
      neg.body.agents.map((a: any) => a.id),
      [created[2]!.id, created[1]!.id],
      "negative offset behaves like offset=0",
    );

    const far = await get(baseUrl, "/agents?limit=200&offset=20000");
    assert.equal(far.status, 200);
    assert.equal(far.body.agents.length, 0);
    assert.equal(far.body.total, 3);
    assert.equal(far.body.truncated, false);
    assert.equal(far.body.hasMore, false);
  } finally {
    await close();
  }
});
