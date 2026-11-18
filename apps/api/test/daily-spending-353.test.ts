import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import type { PolicyRules } from "@4evergent/shared";
import { startServer, apiFetch } from "./helpers.js";

// #353 end-to-end through the real intent handler:
// one intent reserves exactly once, denies reserve nothing, a rejected
// approval releases, and an over-limit first intent does not brick the asset.

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function getSpending(baseUrl: string, agentId = "test-agent") {
  const res = await apiFetch(`${baseUrl}/agents/${agentId}/spending`);
  assert.equal(res.status, 200);
  return (await res.json()) as { spending: Record<string, { used: number; limit: string; remaining: number }> };
}

function payment(amount: string, destination?: string) {
  return {
    type: "payment",
    asset: "XLM",
    destination: destination ?? Keypair.random().publicKey(),
    amount,
    reason: "353 api test",
  };
}

/** Issue example: daily limit 500, maxTx 400, approval above 100. */
const RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "400" },
  dailySpendingLimit: { XLM: "500" },
  requireHumanApprovalForAmountAbove: "100",
};

test("#353 API: one requires_approval intent reserves exactly 300, not 600", async () => {
  const { baseUrl, close, activityStore } = await startServer({ policyRules: RULES });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "requires_approval");
    assert.ok(res.body.approvalId);

    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 300);

    const spending = await getSpending(baseUrl);
    assert.equal(spending.spending.XLM.used, 300);
    assert.equal(spending.spending.XLM.remaining, 200);
  } finally {
    await close();
  }
});

test("#353 API: rejecting the approval releases the reservation; a new intent can use the limit again", async () => {
  const { baseUrl, close, activityStore } = await startServer({ policyRules: RULES });
  try {
    const first = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(first.status, 202);
    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 300);

    const reject = await post(baseUrl, `/approvals/${first.body.approvalId}/reject`, {});
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, "rejected");

    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 0);
    assert.equal((await getSpending(baseUrl)).spending.XLM.used, 0);

    // The freed limit is usable again by a fresh intent.
    const second = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(second.status, 202);
    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 300);
  } finally {
    await close();
  }
});

test("#353 API: allowlist-deny intent reserves nothing", async () => {
  const allowedDest = Keypair.random().publicKey();
  const { baseUrl, close, activityStore } = await startServer({
    policyRules: { ...RULES, allowedDestinations: [allowedDest] },
  });
  try {
    const res = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(res.status, 403);
    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 0);
    assert.equal((await getSpending(baseUrl)).spending.XLM.used, 0);
  } finally {
    await close();
  }
});

test("#353 API: over-limit first intent does not brick the asset", async () => {
  const { baseUrl, close, activityStore } = await startServer({
    policyRules: { ...RULES, maxTxAmount: { XLM: "1000" } },
  });
  try {
    // 600 exceeds the 500 daily limit (but not maxTx 1000) → daily deny.
    const denied = await post(baseUrl, "/agents/test-agent/intents", payment("600"));
    assert.equal(denied.status, 403);
    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 0);

    // An in-limit intent for the same asset still works.
    const ok = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(ok.status, 202);
    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 300);
  } finally {
    await close();
  }
});

test("#353 API: second intent after a 300 reservation is denied when it would exceed the limit", async () => {
  const { baseUrl, close, activityStore } = await startServer({ policyRules: RULES });
  try {
    const first = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(first.status, 202);
    // 300 already reserved; another 300 would total 600 > 500.
    const second = await post(baseUrl, "/agents/test-agent/intents", payment("300"));
    assert.equal(second.status, 403);
    assert.equal((await activityStore.getDailySpending("test-agent", "XLM")) ?? 0, 300);
  } finally {
    await close();
  }
});
