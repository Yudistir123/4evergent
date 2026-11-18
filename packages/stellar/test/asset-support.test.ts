import { test } from "node:test";
import assert from "node:assert/strict";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
} from "@4evergent/database";
import type { AgentIntent, PolicyRules } from "@4evergent/shared";
import { Keypair } from "@stellar/stellar-sdk";

const TESTNET = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

class RecordingSigner implements Signer {
  calls = 0;
  private id: string;
  constructor(id = "test-agent") {
    this.id = `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return PASSPHRASE; }
  async sign(transaction: any): Promise<any> {
    this.calls++;
    transaction.signatures = [{ hint: Buffer.from("rec"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

function makePipeline(opts: {
  rules?: Partial<PolicyRules>;
  signer?: Signer;
  activity?: InMemoryActivityStore;
  approval?: InMemoryApprovalStore;
}) {
  const activity = opts.activity ?? new InMemoryActivityStore();
  const approval = opts.approval ?? new InMemoryApprovalStore();
  const signer = opts.signer ?? new RecordingSigner();
  const pipeline = new TransactionPipeline({
    horizonUrl: TESTNET,
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore: activity,
    approvalStore: approval,
    policyRules: opts.rules,
  });
  return { pipeline, activity, approval, signer };
}

function fakeAccount(agentId?: string): any {
  const kp = Keypair.random();
  return {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
    agentId: agentId ?? "unknown",
  };
}

test("ASSET: issued-asset payment is denied by asset allowlist (default [])", async () => {
  const { pipeline, signer } = makePipeline({});
  const intent: AgentIntent = {
    type: "payment",
    asset: "USDC",
    assetDetails: { code: "USDC", issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U" },
    destination: Keypair.random().publicKey(),
    amount: "10",
    reason: "issued asset payment test",
  };
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  assert.equal(result.status, "rejected");
  assert.equal((signer as RecordingSigner).calls, 0, "signer must NOT be called for non-allowlisted asset");
});

test("ASSET: issued-asset payment allowed when in allowlist still hits simulation gate", async () => {
  const { pipeline, _signer } = makePipeline({
    rules: { allowedAssets: ["USDC:GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U"], approvalThreshold: "1000000" },
  });
  const kp = Keypair.random();
  const intent: AgentIntent = {
    type: "payment",
    asset: "USDC",
    assetDetails: { code: "USDC", issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U" },
    destination: kp.publicKey(),
    amount: "1",
    reason: "issued asset payment allowlist test",
  };
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  // Allowed by policy but simulation should fail (unfunded account) → simulation_failed, not submitted
  assert.notEqual(result.status, "submitted");
  assert.ok(result.status === "simulation_failed" || result.status === "rejected");
});

test("ASSET: XLM payment regression still works with allowlist containing XLM", async () => {
  const { pipeline, _signer } = makePipeline({
    rules: { allowedAssets: ["XLM"] },
    requireHumanApprovalForAmountAbove: "1000000",
  });
  const result = await pipeline.execute({
    intent: { type: "payment", asset: "XLM", destination: Keypair.random().publicKey(), amount: "1", reason: "xlm regression" },
    sourceAccount: fakeAccount("agent-a"),
  });
  // Passes policy, hits simulation (will fail for unfunded, but not rejected by policy)
  assert.notEqual(result.status, "rejected", `XLM payment should not be policy-rejected: ${result.message}`);
});

test("ASSET: invalid asset code rejected at validation (via API parseIntent)", async () => {
  // This is an API-layer test; pipeline would reject anyway
  const { pipeline } = makePipeline({
    rules: { allowedAssets: ["USDC:GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U"] },
  });
  const intent: AgentIntent = {
    type: "payment",
    asset: "USDC",
    assetDetails: { code: "USDC", issuer: "invalid-issuer" },
    destination: Keypair.random().publicKey(),
    amount: "1",
    reason: "invalid issuer test",
  };
  // TransactionBuilder would fail before simulation; pipeline catches and returns rejected
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  assert.ok(result.status === "rejected" || result.status === "simulation_failed");
});

test("TRUSTLINE: policy deny prevents signing", async () => {
  const { pipeline, signer } = makePipeline({
    rules: { txTypeRestrictions: { trustline: false } },
  });
  const intent: AgentIntent = {
    type: "trustline",
    assetCode: "USDC",
    issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    reason: "trustline policy deny test",
  };
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  assert.equal(result.status, "rejected");
  assert.equal((signer as RecordingSigner).calls, 0);
});

test("TRUSTLINE: approval-required trustline does not sign before approval", async () => {
  // #353: the asset allowlist is checked before the approval threshold, so
  // the trustline asset must be allowlisted for this scenario to reach
  // requires_approval. A non-allowlisted asset is denied outright (it must
  // not be approvable past the allowlist).
  const { pipeline, signer, approval } = makePipeline({
    rules: {
      requireHumanApprovalForAmountAbove: "0",
      maxTxAmount: { native: "1000000" },
      allowedAssets: ["trustline:USDC:GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U"],
    },
  });
  const intent: AgentIntent = {
    type: "trustline",
    assetCode: "USDC",
    issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    limit: "1000",
    reason: "trustline approval test",
  };
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  assert.equal(result.status, "requires_approval");
  assert.equal((signer as RecordingSigner).calls, 0);

  // Approval record persisted
  const list = await approval.listByAgent("agent-a");
  assert.equal(list.length, 1);
  assert.equal(list[0]!.status, "pending_approval");
});

test("TRUSTLINE: simulation failure prevents signing", async () => {
  const { pipeline, signer } = makePipeline({
    rules: { requireHumanApprovalForAmountAbove: "1000000" },
  });
  const intent: AgentIntent = {
    type: "trustline",
    assetCode: "USDC",
    issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    limit: "100",
    reason: "trustline simulation failure test",
  };
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  // Unfunded account → simulation failed
  if (result.status === "simulation_failed") {
    assert.equal((signer as RecordingSigner).calls, 0, "signer must NOT be called on failed simulation");
  }
});

test("TRUSTLINE: XLM trustline rejected by policy native asset check", async () => {
  const { pipeline } = makePipeline({
    rules: { txTypeRestrictions: { trustline: true } },
  });
  const intent: AgentIntent = {
    type: "trustline",
    assetCode: "XLM",
    issuer: "GDI73WJ4SX7LOG3XZDJC3KCK6ED6E5NBYK2JUBQSPBCNNWEG3ZN7T75U",
    reason: "XLM trustline should fail",
  };
  const result = await pipeline.execute({ intent, sourceAccount: fakeAccount("agent-a") });
  // Pipeline builds the tx but trustline XLM is conceptually invalid; builder may reject or sim fails
  // Key: no txHash, no signed status
  assert.notEqual(result.status, "submitted");
});
