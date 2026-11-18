import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { clearAgents, createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import { InMemoryAgentStore, SQLiteAgentStore, MAX_LIMIT, closeSharedConnection } from "@4evergent/database";

function makeSigner(accountId: string): any {
  return {
    getAccountId: () => accountId,
    getNetworkPassphrase: () => "Test SDF Network ; September 2015",
    sign: async (tx: any) => tx,
  };
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = res.status !== 204 ? await res.json() : null;
  return { status: res.status, body: json };
}

async function get(url: string, token?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const json = await res.json();
  return { status: res.status, body: json };
}

function runApiCapabilityTests(backendName: string, makeStore: () => { store: InMemoryAgentStore | SQLiteAgentStore; cleanup?: () => void }) {
  test(`${backendName}: GET /agents?capability=payment returns matching agents with full capability array`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      // Create agent 1 with payment and trustline
      const c1 = await post(`${baseUrl}/agents`, {
        displayName: "Payment + Trustline",
        capabilities: ["payment", "trustline"],
      });
      assert.equal(c1.status, 201);

      // Create agent 2 with trustline only
      const c2 = await post(`${baseUrl}/agents`, {
        displayName: "Trustline only",
        capabilities: ["trustline"],
      });
      assert.equal(c2.status, 201);

      // Create agent 3 with payment only
      const c3 = await post(`${baseUrl}/agents`, {
        displayName: "Payment only",
        capabilities: ["payment"],
      });
      assert.equal(c3.status, 201);

      // Query GET /agents?capability=payment
      const res = await get(`${baseUrl}/agents?capability=payment`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.agents));
      assert.equal(res.body.agents.length, 2);

      const returnedIds = res.body.agents.map((a: any) => a.id);
      assert.ok(returnedIds.includes(c1.body.agent.id));
      assert.ok(returnedIds.includes(c3.body.agent.id));
      assert.ok(!returnedIds.includes(c2.body.agent.id));

      // Each returned agent must state its full capability list
      const agent1 = res.body.agents.find((a: any) => a.id === c1.body.agent.id);
      assert.deepEqual(agent1.capabilities, ["payment", "trustline"]);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: GET /agents?capability=... returns 200 with empty array on no-match (never 404 or 500)`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      await post(`${baseUrl}/agents`, {
        displayName: "Payment Agent",
        capabilities: ["payment"],
      });

      const res = await get(`${baseUrl}/agents?capability=unknown_capability`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { agents: [], hasMore: false, truncated: false, total: 0 });
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: exact match semantics (no prefix or substring) and case sensitivity`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      await post(`${baseUrl}/agents`, {
        displayName: "Payment Agent",
        capabilities: ["payment"],
      });

      // Prefix must not match
      const prefixRes = await get(`${baseUrl}/agents?capability=pay`);
      assert.equal(prefixRes.status, 200);
      assert.deepEqual(prefixRes.body, { agents: [], hasMore: false, truncated: false, total: 0 });

      // Substring / superstring must not match
      const superRes = await get(`${baseUrl}/agents?capability=payment_batching`);
      assert.equal(superRes.status, 200);
      assert.deepEqual(superRes.body, { agents: [], hasMore: false, truncated: false, total: 0 });

      // Case mismatch must not match
      const caseRes = await get(`${baseUrl}/agents?capability=Payment`);
      assert.equal(caseRes.status, 200);
      assert.deepEqual(caseRes.body, { agents: [], hasMore: false, truncated: false, total: 0 });
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: owner isolation holds across two owners`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({
        defaultOwnerId: "owner-alice",
        apiKeys: {
          "token-alice": "owner-alice",
          "token-bob": "owner-bob",
        },
      }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      // Alice creates an agent with payment
      const aliceAgent = await post(
        `${baseUrl}/agents`,
        { displayName: "Alice Payment Agent", capabilities: ["payment"] },
        "token-alice"
      );
      assert.equal(aliceAgent.status, 201);

      // Bob creates an agent with payment
      const bobAgent = await post(
        `${baseUrl}/agents`,
        { displayName: "Bob Payment Agent", capabilities: ["payment"] },
        "token-bob"
      );
      assert.equal(bobAgent.status, 201);

      // Alice queries: must only get Alice's agent
      const aliceQuery = await get(`${baseUrl}/agents?capability=payment`, "token-alice");
      assert.equal(aliceQuery.status, 200);
      assert.equal(aliceQuery.body.agents.length, 1);
      assert.equal(aliceQuery.body.agents[0].id, aliceAgent.body.agent.id);
      assert.equal(aliceQuery.body.agents[0].ownerId, "owner-alice");

      // Bob queries: must only get Bob's agent
      const bobQuery = await get(`${baseUrl}/agents?capability=payment`, "token-bob");
      assert.equal(bobQuery.status, 200);
      assert.equal(bobQuery.body.agents.length, 1);
      assert.equal(bobQuery.body.agents[0].id, bobAgent.body.agent.id);
      assert.equal(bobQuery.body.agents[0].ownerId, "owner-bob");
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: interaction with ?limit= clamping`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      for (let i = 0; i < 5; i++) {
        await post(`${baseUrl}/agents`, {
          displayName: `Agent ${i}`,
          capabilities: ["payment"],
        });
      }

      const res = await get(`${baseUrl}/agents?capability=payment&limit=2`);
      assert.equal(res.status, 200);
      assert.equal(res.body.agents.length, 2);

      // Limit clamped to 1 minimum
      const minRes = await get(`${baseUrl}/agents?capability=payment&limit=0`);
      assert.equal(minRes.status, 200);
      assert.equal(minRes.body.agents.length, 1);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: query executed by store beyond MAX_LIMIT (${MAX_LIMIT})`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      // 1 target agent with capability "payment" (created first, so oldest)
      const target = await store.create({
        displayName: "Oldest Payment Agent",
        ownerId: "owner-a",
        capabilities: ["payment"],
      });

      // MAX_LIMIT + 5 filler agents without "payment"
      for (let i = 0; i < MAX_LIMIT + 5; i++) {
        await store.create({
          displayName: `Filler ${i}`,
          ownerId: "owner-a",
          capabilities: ["other"],
        });
      }

      // If handler had capped before filtering, the target would be lost.
      // Store-level filtering ensures the target is found.
      const res = await get(`${baseUrl}/agents?capability=payment`);
      assert.equal(res.status, 200);
      assert.equal(res.body.agents.length, 1);
      assert.equal(res.body.agents[0].id, target.id);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: default limit is ${MAX_LIMIT} when parameter is omitted`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      // Create 3 agents
      for (let i = 0; i < 3; i++) {
        await post(`${baseUrl}/agents`, {
          displayName: `Agent ${i}`,
          capabilities: ["payment"],
        });
      }

      // No limit param → all agents returned (up to MAX_LIMIT=200 default)
      const res = await get(`${baseUrl}/agents?capability=payment`);
      assert.equal(res.status, 200);
      assert.equal(res.body.agents.length, 3);

      const resNoCapability = await get(`${baseUrl}/agents`);
      assert.equal(resNoCapability.status, 200);
      assert.equal(resNoCapability.body.agents.length, 3);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: limit=0 clamps to 1`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      for (let i = 0; i < 5; i++) {
        await post(`${baseUrl}/agents`, {
          displayName: `Agent ${i}`,
          capabilities: ["payment"],
        });
      }

      const res = await get(`${baseUrl}/agents?capability=payment&limit=0`);
      assert.equal(res.status, 200);
      assert.equal(res.body.agents.length, 1);

      const resNoCapability = await get(`${baseUrl}/agents?limit=0`);
      assert.equal(resNoCapability.status, 200);
      assert.equal(resNoCapability.body.agents.length, 1);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: limit exceeding MAX_LIMIT clamps to ${MAX_LIMIT}`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      // Create 3 agents — fewer than MAX_LIMIT, so we just verify no error
      for (let i = 0; i < 3; i++) {
        await post(`${baseUrl}/agents`, {
          displayName: `Agent ${i}`,
          capabilities: ["payment"],
        });
      }

      const res = await get(`${baseUrl}/agents?capability=payment&limit=999`);
      assert.equal(res.status, 200);
      assert.equal(res.body.agents.length, 3);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: negative limit clamps to 1`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      for (let i = 0; i < 3; i++) {
        await post(`${baseUrl}/agents`, {
          displayName: `Agent ${i}`,
          capabilities: ["payment"],
        });
      }

      const res = await get(`${baseUrl}/agents?capability=payment&limit=-5`);
      assert.equal(res.status, 200);
      assert.equal(res.body.agents.length, 1);
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: fractional limit (e.g. 1.5) returns 400 VALIDATION_ERROR`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      const res = await get(`${baseUrl}/agents?limit=1.5`);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.includes("integer"));

      const resCap = await get(`${baseUrl}/agents?capability=payment&limit=2.7`);
      assert.equal(resCap.status, 400);
      assert.equal(resCap.body.code, "VALIDATION_ERROR");
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: non-numeric limit (e.g. "abc") returns 400 VALIDATION_ERROR`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      const res = await get(`${baseUrl}/agents?limit=abc`);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.includes("integer"));

      const resCap = await get(`${baseUrl}/agents?capability=payment&limit=xyz`);
      assert.equal(resCap.status, 400);
      assert.equal(resCap.body.code, "VALIDATION_ERROR");
    } finally {
      await server.close();
      cleanup?.();
    }
  });

  test(`${backendName}: empty limit (limit=) returns 400 VALIDATION_ERROR`, async () => {
    clearAgents();
    const { store, cleanup } = makeStore();
    const server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: makeSigner("GTEST"),
      agentStore: store,
      authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    });
    await server.listen(0);
    const baseUrl = `http://127.0.0.1:${(server.server.address() as any).port}`;

    try {
      const res = await get(`${baseUrl}/agents?limit=`);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.includes("integer"));

      const resCap = await get(`${baseUrl}/agents?capability=payment&limit=`);
      assert.equal(resCap.status, 400);
      assert.equal(resCap.body.code, "VALIDATION_ERROR");
    } finally {
      await server.close();
      cleanup?.();
    }
  });
}

runApiCapabilityTests("InMemoryAgentStore", () => ({
  store: new InMemoryAgentStore(),
}));

runApiCapabilityTests("SQLiteAgentStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-api-cap-test-"));
  const path = join(dir, "api-cap-test.db");
  const store = new SQLiteAgentStore(path);
  return {
    store,
    cleanup: () => {
      closeSharedConnection(path);
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
