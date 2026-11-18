// #371: concurrent duplicate submissions with the same Idempotency-Key.
//
// The pre-check alone cannot dedupe concurrent requests: two overlapping
// requests both pass it before either persists anything, so both would
// evaluate policy (reserving daily spending twice, #353) and both would
// execute. The per-key lock in handleIntent serializes them; the second
// waits, then replays the first request's record.
//
// The ALLOW tests stub the Horizon-touching seams (slow getAccount +
// slow counting submitter) so the first request is genuinely in flight —
// inside the sequence coordinator, past the point where the old code had
// persisted nothing — while the second request arrives. Offline, a real
// Horizon submit is unreachable (network guard + LIVE_SUBMIT gate), so
// "exactly one submission" is counted at the stubbed submitter, and the
// activity record + daily-spending reservation prove the single execution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { StellarAdapter } from "@4evergent/agent-core";
import { StellarSimulator, StellarSubmitter } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import { Keypair } from "@stellar/stellar-sdk";
import { startServer, apiFetch, sleep } from "./helpers.js";
import type { Signer } from "@4evergent/stellar";

const DEST = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

// The signer MUST be a real Stellar keypair: the pipeline builds a real
// transaction from it, and the helpers' MockSigner only assigns
// `transaction.signatures`, which a real built transaction rejects as
// "Transaction is immutable". A random keypair signs properly and its
// public key is a valid source account.
class RealTestSigner implements Signer {
  private kp = Keypair.random();
  getAccountId(): string {
    return this.kp.publicKey();
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    transaction.sign(this.kp);
    return transaction;
  }
}
const VALID_SIGNER = new RealTestSigner();
const SUBMIT_HASH = "371-test-tx-hash";

function payment(amount: string) {
  return {
    type: "payment",
    asset: "XLM",
    destination: DEST,
    amount,
    reason: "371 test",
  };
}

/** Amount 10 stays below the 10000 approval threshold: ALLOW path. */
const ALLOW_RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  dailySpendingLimit: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10000",
  approvalThreshold: "10000",
};

/** Amount 100 is at/above the 50 approval threshold: requires_approval. */
const APPROVAL_RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  dailySpendingLimit: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "50",
  approvalThreshold: "50",
};

async function postIntent(baseUrl: string, key: string, body: unknown) {
  const res = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/**
 * Replaces the Horizon-touching seams with slow offline fakes and counts
 * submitter calls. The account load is slow (first request sits inside the
 * sequence coordinator) and the submitter is slow (first request sits
 * between sign and persist) — either delay alone overlaps the second
 * request; together they cover the whole ALLOW window.
 */
function installSlowStubs(submitDelayMs: number): {
  getSubmitCalls: () => number;
  restore: () => void;
} {
  const origGetAccount = StellarAdapter.prototype.getAccount;
  const origSimulate = StellarSimulator.prototype.simulate;
  const origSubmit = StellarSubmitter.prototype.submit;
  let submitCalls = 0;
  StellarAdapter.prototype.getAccount = (async (address: string) => {
    await sleep(150);
    return { address, sequence: "1", balances: [], subentryCount: 0 };
  }) as any;
  StellarSimulator.prototype.simulate = (async () => ({
    success: true,
    fee: "100",
    operations: 1,
    warnings: [],
  })) as any;
  StellarSubmitter.prototype.submit = (async () => {
    submitCalls++;
    await sleep(submitDelayMs);
    return { hash: SUBMIT_HASH, ledger: 123 };
  }) as any;
  return {
    getSubmitCalls: () => submitCalls,
    restore: () => {
      StellarAdapter.prototype.getAccount = origGetAccount;
      StellarSimulator.prototype.simulate = origSimulate;
      StellarSubmitter.prototype.submit = origSubmit;
    },
  };
}

test("#371 API: two concurrent same-key ALLOW intents submit exactly once", async () => {
  const { baseUrl, close, activityStore } = await startServer({ policyRules: ALLOW_RULES, signer: VALID_SIGNER });
  const stubs = installSlowStubs(300);
  try {
    const [first, second] = await Promise.all([
      postIntent(baseUrl, "371-allow-key", payment("10")),
      postIntent(baseUrl, "371-allow-key", payment("10")),
    ]);

    // Both return the FIRST request's activity (200), not two executions.
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.activityId, second.body.activityId);

    // Exactly one submission reached the submitter, despite the overlap.
    assert.equal(stubs.getSubmitCalls(), 1);

    // Exactly one activity record, holding the first submission's hash.
    const records = await activityStore.listByAgent("test-agent", 50);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, first.body.activityId);
    assert.equal(records[0].status, "submitted");
    assert.equal(records[0].txHash, SUBMIT_HASH);

    // Exactly one daily-spending reservation (#353: one intent = one).
    assert.equal(await activityStore.getDailySpending("test-agent", "XLM"), 10);
  } finally {
    stubs.restore();
    await close();
  }
});

test("#371 API: two concurrent same-key requires_approval intents create exactly one pending approval", async () => {
  const { baseUrl, close, activityStore, approvalStore } = await startServer({
    policyRules: APPROVAL_RULES,
  });
  try {
    const [first, second] = await Promise.all([
      postIntent(baseUrl, "371-approval-key", payment("100")),
      postIntent(baseUrl, "371-approval-key", payment("100")),
    ]);

    // One winner (202 with approvalId), one replay (200, same activity).
    assert.deepEqual([first.status, second.status].sort(), [200, 202]);
    assert.equal(first.body.activityId, second.body.activityId);

    const records = await activityStore.listByAgent("test-agent", 50);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "requires_approval");

    const pending = await approvalStore.listByAgent("test-agent", 50, 0, "pending_approval");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].activityId, first.body.activityId);

    // Exactly one daily-spending reservation for the single intent.
    assert.equal(await activityStore.getDailySpending("test-agent", "XLM"), 100);
  } finally {
    await close();
  }
});

test("#371 API: sequential duplicate after submit returns the first activity (200) without re-submitting", async () => {
  const { baseUrl, close, activityStore } = await startServer({ policyRules: ALLOW_RULES, signer: VALID_SIGNER });
  const stubs = installSlowStubs(0);
  try {
    const first = await postIntent(baseUrl, "371-seq-key", payment("10"));
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "submitted");

    const second = await postIntent(baseUrl, "371-seq-key", payment("10"));
    assert.equal(second.status, 200);
    assert.equal(second.body.activityId, first.body.activityId);
    assert.equal(second.body.txHash, SUBMIT_HASH);

    assert.equal(stubs.getSubmitCalls(), 1);
    assert.equal((await activityStore.listByAgent("test-agent", 50)).length, 1);
    assert.equal(await activityStore.getDailySpending("test-agent", "XLM"), 10);
  } finally {
    stubs.restore();
    await close();
  }
});

test("#371 API: same key + different intent is still a 409 and submits nothing new", async () => {
  const { baseUrl, close, activityStore } = await startServer({ policyRules: ALLOW_RULES, signer: VALID_SIGNER });
  const stubs = installSlowStubs(0);
  try {
    const first = await postIntent(baseUrl, "371-conflict-key", payment("10"));
    assert.equal(first.status, 200);

    const second = await postIntent(baseUrl, "371-conflict-key", payment("20"));
    assert.equal(second.status, 409);

    assert.equal(stubs.getSubmitCalls(), 1);
    assert.equal((await activityStore.listByAgent("test-agent", 50)).length, 1);
    assert.equal(await activityStore.getDailySpending("test-agent", "XLM"), 10);
  } finally {
    stubs.restore();
    await close();
  }
});
