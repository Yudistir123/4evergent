import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";

declare const fetch: typeof globalThis.fetch;

// --- helpers ---

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string {
    return this.id;
  }
  getNetworkPassphrase(): string {
    return "Test SDF Network ; September 2015";
  }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test Agent",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: ["payment"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  status: "active" as const,
  metadata: {},
};

async function startServer(auth: boolean = true) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    authProvider: auth ? new DevAuthProvider({ defaultOwnerId: "test" }) : undefined,
  });
  server.registerAgent(TEST_AGENT);

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Captures everything written to process.stdout. Must be restored before
 * the test finishes so later tests keep writing to the real stdout.
 */
function captureStdout(): { lines: string[]; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: any, ..._rest: any[]) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function findRequestLine(lines: string[]): Record<string, unknown> | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes("\"msg\":\"request completed\"")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* not JSON, skip */
      }
    }
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// --- tests ---

test("request without X-Request-Id receives a generated one", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId, "X-Request-Id response header must be set");
    assert.match(requestId ?? "", UUID_RE, "generated ID must be a UUID");
  } finally {
    await close();
  }
});

test("request with X-Request-Id echoes the supplied value", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const supplied = "client-supplied-correlation-id";
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "X-Request-Id": supplied },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), supplied, "supplied ID must be echoed");
  } finally {
    await close();
  }
});

test("log line contains method, path, status, duration, requestId", async () => {
  const { baseUrl, close } = await startServer();
  const capture = captureStdout();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);

    const entry = findRequestLine(capture.lines);
    assert.ok(entry, "a 'request completed' log line must be emitted");
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/health");
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, "number");
    assert.ok((entry.durationMs as number) >= 0, "durationMs must be non-negative");
    assert.match(entry.requestId as string, UUID_RE, "requestId must be a UUID");
  } finally {
    capture.restore();
    await close();
  }
});

test("Authorization header is never written to the log", async () => {
  const { baseUrl, close } = await startServer();
  const capture = captureStdout();
  try {
    const secret = "Bearer super-secret-token-abc123";
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { Authorization: secret },
    });
    assert.equal(res.status, 200);

    const entry = findRequestLine(capture.lines);
    assert.ok(entry, "a log line must be emitted");
    assert.ok(
      !JSON.stringify(entry).includes("super-secret-token-abc123"),
      "Authorization header value must not appear in the log",
    );
    assert.ok(
      !JSON.stringify(entry).includes("Bearer"),
      "no Authorization value should be present",
    );
  } finally {
    capture.restore();
    await close();
  }
});

test("error responses include the correlation ID header", async () => {
  process.env.CORS_ORIGIN = "https://preview-4evergent.vercel.app";
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/definitely-not-a-route`, {
      headers: { Origin: "https://preview-4evergent.vercel.app" },
    });
    assert.equal(res.status, 404);
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId, "404 responses must carry X-Request-Id");
    assert.match(requestId ?? "", UUID_RE);
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("OPTIONS preflight also carries a correlation ID", async () => {
  process.env.CORS_ORIGIN = "https://preview-4evergent.vercel.app";
  const { baseUrl, close } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://preview-4evergent.vercel.app" },
    });
    assert.equal(res.status, 204);
    assert.ok(res.headers.get("x-request-id"), "preflight must carry X-Request-Id");
  } finally {
    await close();
    delete process.env.CORS_ORIGIN;
  }
});

test("ownerId is null without authProvider and set with auth", async () => {
  // Server WITHOUT authProvider — all requests unauthenticated, ownerId null
  const { baseUrl: noAuthBaseUrl, close: closeNoAuth } = await startServer(false);
  const noAuthCapture = captureStdout();
  try {
    await fetch(`${noAuthBaseUrl}/health`);

    const entry = findRequestLine(noAuthCapture.lines);
    assert.ok(entry, "health request must be logged");
    assert.equal(entry.ownerId, null, "request without authProvider has null ownerId");
  } finally {
    noAuthCapture.restore();
    await closeNoAuth();
  }

  // Server WITH authProvider — ownerId is set
  const { baseUrl, close } = await startServer();
  const capture = captureStdout();
  try {
    await fetch(`${baseUrl}/health`);

    const entry = findRequestLine(capture.lines);
    assert.ok(entry, "health request must be logged");
    assert.equal(entry.ownerId, "test", "authenticated request carries the ownerId");
  } finally {
    capture.restore();
    await close();
  }
});
