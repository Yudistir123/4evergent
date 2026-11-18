import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { PolicyEngine } from "../src/engine.js";
import type { AgentIntent } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  SQLiteActivityStore,
  type ActivityStore,
} from "../../database/src/index.js";

// #353: one intent = one reservation; denies never reserve; the approval-time
// re-check reads the reservation table (same source as the spending endpoint).

const DEST = "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_DEST = "GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA";

function makePaymentIntent(amount: string, destination = DEST): AgentIntent {
  return { type: "payment", asset: "XLM", destination, amount, reason: "test" };
}

/** Issue #353 example: daily limit 500, maxTx 400, payment 300. */
function makeIssuePolicy() {
  return {
    maxTxAmount: { XLM: "400" },
    dailySpendingLimit: { XLM: "500" },
    allowedAssets: ["XLM"],
    allowedDestinations: [] as string[],
    allowedContractIds: [] as string[],
    txTypeRestrictions: { payment: true, trustline: true, contract_call: false, account_settings: false },
    approvalThreshold: "10000",
    requireHumanApprovalForAmountAbove: "10000",
  };
}

function makeApprovalPolicy() {
  return {
    ...makeIssuePolicy(),
    approvalThreshold: "100",
    requireHumanApprovalForAmountAbove: "100",
  };
}

function makeStore(backend: "InMemory" | "SQLite"): { store: ActivityStore; cleanup: () => void } {
  if (backend === "InMemory") {
    return { store: new InMemoryActivityStore(), cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), "policy-353-"));
  const store = new SQLiteActivityStore(join(tmp, "test.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function reserved(store: ActivityStore, agentId = "agent-1"): Promise<number> {
  return (await store.getDailySpending(agentId, "XLM")) ?? 0;
}

const BACKENDS = ["InMemory", "SQLite"] as const;

for (const backend of BACKENDS) {
  test(`#353 [${backend}] issue example: 300 of 500 limit with maxTx 400 is allowed, reserves exactly 300`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(makeIssuePolicy(), store as any);
      const decision = await engine.evaluate(makePaymentIntent("300"), "agent-1");
      assert.equal(decision.result, "allow");
      assert.deepEqual(decision.reservedDailySpending, { asset: "XLM", amount: "300" });
      assert.equal(await reserved(store), 300);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] allowlist deny (destination) reserves nothing`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(
        { ...makeIssuePolicy(), allowedDestinations: [OTHER_DEST] },
        store as any
      );
      const decision = await engine.evaluate(makePaymentIntent("300"), "agent-1");
      assert.equal(decision.result, "deny");
      assert.match(decision.reason, /allowed_destinations/);
      assert.equal(decision.reservedDailySpending, undefined);
      assert.equal(await reserved(store), 0);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] allowlist deny (asset) reserves nothing`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(
        { ...makeIssuePolicy(), allowedAssets: ["USDC"] },
        store as any
      );
      const decision = await engine.evaluate(makePaymentIntent("300"), "agent-1");
      assert.equal(decision.result, "deny");
      assert.match(decision.reason, /allowed_assets/);
      assert.equal(decision.reservedDailySpending, undefined);
      assert.equal(await reserved(store), 0);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] maxTx deny reserves nothing`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(makeIssuePolicy(), store as any);
      const decision = await engine.evaluate(makePaymentIntent("450"), "agent-1");
      assert.equal(decision.result, "deny");
      assert.equal(decision.reservedDailySpending, undefined);
      assert.equal(await reserved(store), 0);
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] deny after a successful reservation leaves the earlier reservation intact`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(
        { ...makeIssuePolicy(), allowedDestinations: [OTHER_DEST] },
        store as any
      );
      const ok = await engine.evaluate(makePaymentIntent("100", OTHER_DEST), "agent-1");
      assert.equal(ok.result, "allow");
      assert.equal(await reserved(store), 100);
      const denied = await engine.evaluate(makePaymentIntent("100", DEST), "agent-1");
      assert.equal(denied.result, "deny");
      assert.equal(await reserved(store), 100, "deny must not consume or release anything");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] skipReservation re-check reads the reservation table: tightened limit denies`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      // Creation: 400 reserves (requires_approval at threshold 100).
      const engine = new PolicyEngine(makeApprovalPolicy(), store as any);
      const d1 = await engine.evaluate(makePaymentIntent("400"), "agent-1");
      assert.equal(d1.result, "requires_approval");
      assert.equal(await reserved(store), 400);
      // Policy tightened: daily limit 500 -> 300. Reserved total (400) now
      // exceeds the current limit, so the approval-time re-check denies.
      const tightened = new PolicyEngine(
        { ...makeApprovalPolicy(), dailySpendingLimit: { XLM: "300" } },
        store as any
      );
      const d2 = await tightened.evaluate(makePaymentIntent("400"), "agent-1", { skipReservation: true });
      assert.equal(d2.result, "deny");
      assert.match(d2.reason, /daily limit/);
      assert.equal(await reserved(store), 400, "re-check must not change the reservation");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] skipReservation re-check allows when the limit still covers the reservation`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(makeApprovalPolicy(), store as any);
      const d1 = await engine.evaluate(makePaymentIntent("400"), "agent-1");
      assert.equal(d1.result, "requires_approval");
      const d2 = await engine.evaluate(makePaymentIntent("400"), "agent-1", { skipReservation: true });
      assert.notEqual(d2.result, "deny");
      assert.equal(await reserved(store), 400, "re-check must not double-reserve");
    } finally {
      cleanup();
    }
  });

  test(`#353 [${backend}] release after evaluation frees the limit for a later intent`, async () => {
    const { store, cleanup } = makeStore(backend);
    try {
      const engine = new PolicyEngine(makeIssuePolicy(), store as any);
      const d1 = await engine.evaluate(makePaymentIntent("300"), "agent-1");
      assert.equal(d1.result, "allow");
      assert.equal(await reserved(store), 300);
      // Simulate the pipeline/API release path (deny/failure/reject).
      await store.releaseDailySpending("agent-1", "XLM", "300");
      assert.equal(await reserved(store), 0);
      const d2 = await engine.evaluate(makePaymentIntent("500"), "agent-1");
      assert.equal(d2.result, "deny", "500 exceeds maxTx 400");
      const d3 = await engine.evaluate(makePaymentIntent("400"), "agent-1");
      assert.equal(d3.result, "allow");
      assert.equal(await reserved(store), 400);
    } finally {
      cleanup();
    }
  });
}
