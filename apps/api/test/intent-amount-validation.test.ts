import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";

// Issue #264: parseIntent rejects malformed amounts with VALIDATION_ERROR.
// Node 18+ has global fetch; declare it for TS
declare const fetch: typeof globalThis.fetch;

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

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
  capabilities: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

const DESTINATION = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";

async function startServer(opts?: { policyRules?: Partial<PolicyRules> }) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: opts?.policyRules,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const PAYMENT = (amount: string) => ({
  type: "payment",
  asset: "XLM",
  destination: DESTINATION,
  amount,
  reason: "test",
});

test("API returns 400 VALIDATION_ERROR for malformed payment amounts", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "500" },
  });
  try {
    for (const amount of ["10abc", "1e2", "", "-5", "0.00000001"]) {
      const res = await post(baseUrl, "/agents/test-agent/intents", PAYMENT(amount));
      assert.equal(res.status, 400, amount);
      assert.equal(res.body.code, "VALIDATION_ERROR", amount);
    }
  } finally {
    await close();
  }
});

test("API accepts valid payment amounts (1 stroop and decimals)", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "500" },
  });
  try {
    for (const amount of ["0.0000001", "100.5"]) {
      const res = await post(baseUrl, "/agents/test-agent/intents", PAYMENT(amount));
      assert.notEqual(res.status, 400, amount);
      assert.notEqual(res.body.code, "VALIDATION_ERROR", amount);
    }
  } finally {
    await close();
  }
});

test("API returns 400 VALIDATION_ERROR for malformed trustline limit", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "trustline",
      assetCode: "USDC",
      issuer: `G${"B".repeat(55)}`,
      limit: "10abc",
      reason: "test",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
  } finally {
    await close();
  }
});
