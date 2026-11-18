import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrictAmount, isStrictAmount } from "../src/amount.js";
import { PolicyEngine } from "../src/engine.js";
import { validatePolicyRules } from "../src/validation.js";

// Issue #264: one shared strict decimal parser for Stellar amounts.
// Canonical form: digits, optional "." plus 1–7 fractional digits.
// No exponent, no whitespace, no sign, no trailing junk.

test("parseStrictAmount accepts canonical Stellar amounts", () => {
  for (const [input, expected] of [
    ["0", 0],
    ["10", 10],
    ["100.5", 100.5],
    ["0.0000001", 0.0000001],
    ["0.5", 0.5],
    ["123456789.1234567", 123456789.1234567],
  ] as const) {
    assert.equal(parseStrictAmount(input), expected, input);
    assert.equal(isStrictAmount(input), true, input);
  }
  // Numeric config values use their canonical string form.
  assert.equal(parseStrictAmount(100), 100);
  assert.equal(parseStrictAmount(0), 0);
  assert.equal(parseStrictAmount(100.5), 100.5);
});

test("parseStrictAmount rejects malformed amounts", () => {
  for (const input of [
    "10abc",
    "1e2",
    "1E2",
    "",
    "-5",
    "-0.5",
    "+10",
    "0.00000001", // 8 fractional digits
    " 10",
    "10 ",
    "10.5.5",
    ".5",
    "5.",
    "NaN",
    "Infinity",
    "0x10",
    "1_000",
    "10,5",
    "abc",
  ]) {
    assert.equal(parseStrictAmount(input), null, JSON.stringify(input));
    assert.equal(isStrictAmount(input), false, JSON.stringify(input));
  }
  for (const input of [null, undefined, {}, [], true, Number.NaN, Number.POSITIVE_INFINITY, -5, 0.00000001]) {
    assert.equal(parseStrictAmount(input), null, String(input));
  }
});

test("PolicyEngine denies malformed amounts and allows valid ones", async () => {
  const engine = new PolicyEngine({
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "500",
  });
  const intent = (amount: string) => ({
    type: "payment" as const,
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount,
    reason: "test",
  });

  for (const amount of ["10abc", "1e2", "", "-5", "0.00000001"]) {
    const result = await engine.evaluate(intent(amount), "agent-a");
    assert.equal(result.result, "deny", amount);
  }

  for (const amount of ["0.0000001", "100.5", "10"]) {
    const result = await engine.evaluate(intent(amount), "agent-a");
    assert.equal(result.result, "allow", amount);
  }
});

test("validatePolicyRules rejects malformed limits and thresholds", () => {
  for (const amount of ["10abc", "1e2", "0.00000001"]) {
    assert.equal(validatePolicyRules({ maxTxAmount: { XLM: amount } }).valid, false, amount);
    assert.equal(validatePolicyRules({ dailySpendingLimit: { XLM: amount } }).valid, false, amount);
    assert.equal(validatePolicyRules({ approvalThreshold: amount }).valid, false, amount);
  }
  assert.equal(validatePolicyRules({ maxTxAmount: { XLM: "0.0000001" } }).valid, true);
  assert.equal(validatePolicyRules({ maxTxAmount: { XLM: "100.5" } }).valid, true);
  assert.equal(validatePolicyRules({ maxTxAmount: { XLM: 100 } }).valid, true);
});
