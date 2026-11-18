import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, waitFor, apiFetch } from "./helpers.js";
import { StellarAdapter } from "@4evergent/agent-core";
import {
  StellarTransactionBuilder,
  StellarSimulator,
  StellarSubmitter,
} from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";

// Issue #275: approved intents never executed on the default queue path —
// the queue re-ran pipeline.execute() instead of executeApproved(), so the
// re-evaluation created a duplicate approval and the record dead-lettered.
// This test runs the full createApiServer with the queue enabled and the
// Stellar network steps stubbed at the prototype level (no live Horizon).

const TX_HASH = "stub-tx-hash-275";
const ADDRESS = "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U";
const DESTINATION = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

async function post(baseUrl: string, path: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Stub the network-dependent pipeline steps. The pipeline instance is
 * created inside createApiServer, so the stubs go on the prototypes —
 * the same technique execute-approved.test.ts uses for getAccount.
 * Restores everything afterwards.
 */
function stubNetwork() {
  const originals = {
    getAccount: StellarAdapter.prototype.getAccount,
    buildPayment: StellarTransactionBuilder.prototype.buildPayment,
    simulate: StellarSimulator.prototype.simulate,
    submit: StellarSubmitter.prototype.submit,
  };
  StellarAdapter.prototype.getAccount = (async () => ({
    address: ADDRESS,
    sequence: "1",
    balances: [],
    subentryCount: 0,
  })) as typeof originals.getAccount;
  StellarTransactionBuilder.prototype.buildPayment = (async () => ({
    hash: () => Buffer.from("pre-submit-hash"),
  })) as typeof originals.buildPayment;
  StellarSimulator.prototype.simulate = (async () => ({
    success: true,
    fee: "100",
    operations: 1,
    warnings: [],
  })) as typeof originals.simulate;
  StellarSubmitter.prototype.submit = (async () => ({
    hash: TX_HASH,
    ledger: 123,
  })) as typeof originals.submit;
  return () => {
    StellarAdapter.prototype.getAccount = originals.getAccount;
    StellarTransactionBuilder.prototype.buildPayment = originals.buildPayment;
    StellarSimulator.prototype.simulate = originals.simulate;
    StellarSubmitter.prototype.submit = originals.submit;
  };
}

const RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

test("approval → queue → executeApproved: approved intent submits exactly once, one approval", async () => {
  const restore = stubNetwork();
  const { baseUrl, close, activityStore: store, approvalStore: approvals, executionStore } = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 50,
  });
  try {
    const intentRes = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "50",
      reason: "queue dispatch test",
    });
    assert.equal(intentRes.status, 202);
    assert.equal(intentRes.body.status, "requires_approval");
    const approvalId = intentRes.body.approvalId as string;
    const activityId = intentRes.body.activityId as string;
    assert.ok(approvalId);
    assert.ok(activityId);

    const approveRes = await post(baseUrl, `/approvals/${approvalId}/approve`, { approver: "tester" });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, "approved");

    // The queue (50ms tick) must dispatch the record to executeApproved().
    const execution = await waitFor(
      async () => {
        const all = await executionStore.listByOwner("test", 10);
        return all.find((e) => e.approvalId === approvalId && e.status === "submitted");
      },
      5000,
      50
    );
    assert.ok(execution, "execution should reach submitted via the queue");
    assert.equal(execution?.txHash, TX_HASH);
    assert.equal(execution?.approvalId, approvalId);

    const approval = await approvals.get(approvalId);
    assert.equal(approval?.status, "submitted");
    assert.equal(approval?.txHash, TX_HASH);
    // Approver recorded at approve time (dev-user via DevAuthProvider) must
    // survive — the queue path passes no approver to executeApproved().
    assert.equal(approval?.approver, "dev-user");

    // Exactly one approval record for the intent — no duplicate created by
    // a re-run of pipeline.execute().
    const allApprovals = await approvals.listByAgent("test-agent", 50);
    assert.equal(
      allApprovals.filter((a) => a.activityId === activityId).length,
      1
    );

    const activity = await store.get(activityId);
    assert.equal(activity?.status, "submitted");
    assert.equal(activity?.txHash, TX_HASH);
  } finally {
    await close();
    restore();
  }
});

test("records without approvalId still go through execute() (scheduler/manual path unchanged)", async () => {
  const restore = stubNetwork();
  const { baseUrl, close } = await startServer({
    policyRules: RULES,
    schedulerEnabled: true,
    intervalMs: 50,
  });
  try {
    // Below the approval threshold: the direct execute() path submits.
    const res = await post(baseUrl, "/agents/test-agent/intents", {
      type: "payment",
      asset: "XLM",
      destination: DESTINATION,
      amount: "5",
      reason: "direct path test",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "submitted");
    assert.equal(res.body.txHash, TX_HASH);
  } finally {
    await close();
    restore();
  }
});
