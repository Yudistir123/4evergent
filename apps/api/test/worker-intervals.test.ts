// Worker interval env vars: RECONCILIATION_INTERVAL_MS,
// RECONCILIATION_MAX_AGE_MS, EXECUTION_QUEUE_INTERVAL_MS, SCHEDULER_INTERVAL_MS.
//
// Offline and deterministic: no network, no secrets. The server is started on
// loopback with mock signer, and the worker startup log lines are captured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntervalEnv, readWorkerIntervals } from "../src/server.js";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";

class MockSigner implements Signer {
  getAccountId(): string {
    return `G${"A".repeat(55)}`;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    return transaction;
  }
}

test("unset or empty interval env var yields undefined (worker default)", () => {
  assert.equal(parseIntervalEnv("X", undefined), undefined);
  assert.equal(parseIntervalEnv("X", ""), undefined);
  assert.equal(parseIntervalEnv("X", "   "), undefined);
});

test("valid interval env var is parsed to a number", () => {
  assert.equal(parseIntervalEnv("X", "5000"), 5000);
});

test("non-numeric and non-positive values throw a clear error naming the variable", () => {
  for (const bad of ["abc", "0", "-5", "NaN", "Infinity", "10s"]) {
    assert.throws(
      () => parseIntervalEnv("RECONCILIATION_INTERVAL_MS", bad),
      (err: Error) =>
        err.message.includes("RECONCILIATION_INTERVAL_MS") && err.message.includes(`'${bad}'`),
      `expected '${bad}' to be rejected`
    );
  }
});

test("each of the four variables is validated", () => {
  for (const name of ["RECONCILIATION_INTERVAL_MS", "RECONCILIATION_MAX_AGE_MS", "EXECUTION_QUEUE_INTERVAL_MS", "SCHEDULER_INTERVAL_MS"]) {
    assert.throws(() => readWorkerIntervals({ [name]: "abc" }), new RegExp(name));
  }
});

test("readWorkerIntervals maps each variable to its worker", () => {
  assert.deepEqual(
    readWorkerIntervals({
      RECONCILIATION_INTERVAL_MS: "1111",
      RECONCILIATION_MAX_AGE_MS: "4444",
      EXECUTION_QUEUE_INTERVAL_MS: "2222",
      SCHEDULER_INTERVAL_MS: "3333",
    }),
    { reconciliationIntervalMs: 1111, reconciliationMaxAgeMs: 4444, executionQueueIntervalMs: 2222, schedulerIntervalMs: 3333 }
  );
  assert.deepEqual(readWorkerIntervals({}), {
    reconciliationIntervalMs: undefined,
    reconciliationMaxAgeMs: undefined,
    executionQueueIntervalMs: undefined,
    schedulerIntervalMs: undefined,
  });
});

test("env-provided intervals reach the workers (asserted via startup log lines)", async () => {
  const intervals = readWorkerIntervals({
    RECONCILIATION_INTERVAL_MS: "123456",
    RECONCILIATION_MAX_AGE_MS: "456789",
    EXECUTION_QUEUE_INTERVAL_MS: "234567",
    SCHEDULER_INTERVAL_MS: "345678",
  });

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  let server: Awaited<ReturnType<typeof createApiServer>> | undefined;
  try {
    server = await createApiServer({
      port: 0,
      horizonUrl: "https://horizon-testnet.stellar.org",
      signer: new MockSigner(),
      authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
      reconciliation: { enabled: true, intervalMs: intervals.reconciliationIntervalMs, maxAgeMs: intervals.reconciliationMaxAgeMs },
      executionQueue: { enabled: true, intervalMs: intervals.executionQueueIntervalMs },
      scheduler: { enabled: true, intervalMs: intervals.schedulerIntervalMs },
    });
  } finally {
    console.log = originalLog;
    await server?.close();
  }

  assert.ok(lines.includes("[reconciler] started, interval: 123456 ms"), lines.join("\n"));
  assert.ok(lines.includes("[reconciler] not_found max age: 456789 ms"), lines.join("\n"));
  assert.ok(lines.includes("[execution-queue] started, interval: 234567 ms"), lines.join("\n"));
  assert.ok(lines.includes("[scheduler] started, interval: 345678 ms"), lines.join("\n"));
});
