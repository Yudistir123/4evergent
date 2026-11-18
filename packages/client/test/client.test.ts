import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient } from "../src/index.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function setup(status = 200, responseBody: unknown = {}) {
  const calls: CapturedRequest[] = [];
  const client = createClient({
    baseUrl: "https://api.example.test/",
    token: "test-token",
    fetch: async (input, init = {}) => {
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { client, calls };
}

test("every documented client route uses the expected method and path", async () => {
  const { client, calls } = setup();
  const intent = {
    type: "payment" as const,
    asset: "XLM",
    destination: "GDESTINATION",
    amount: "1",
    reason: "test",
  };
  const policy = {
    maxTxAmount: { XLM: "10" },
    dailySpendingLimit: { XLM: "50" },
    allowedAssets: ["XLM"],
    allowedDestinations: [],
    allowedContractIds: [],
    txTypeRestrictions: { payment: true },
    approvalThreshold: "5",
    requireHumanApprovalForAmountAbove: "5",
  };

  const routes: Array<{ call: () => Promise<unknown>; method: string; path: string }> = [
    { call: () => client.health(), method: "GET", path: "/health" },
    { call: () => client.createAgent({ displayName: "bot" }), method: "POST", path: "/agents" },
    { call: () => client.listAgents({ limit: 10, offset: 2 }), method: "GET", path: "/agents?limit=10&offset=2" },
    { call: () => client.getAgent("agent id"), method: "GET", path: "/agents/agent%20id" },
    { call: () => client.updateAgentStatus("a", "paused"), method: "PATCH", path: "/agents/a/status" },
    { call: () => client.submitIntent("a", intent, { idempotencyKey: "key-1" }), method: "POST", path: "/agents/a/intents" },
    { call: () => client.listApprovals({ status: "pending approval", limit: 10, offset: 2 }), method: "GET", path: "/approvals?status=pending+approval&limit=10&offset=2" },
    { call: () => client.getApproval("ap/1"), method: "GET", path: "/approvals/ap%2F1" },
    { call: () => client.listAgentApprovals("a", { status: "pending", limit: 10, offset: 1 }), method: "GET", path: "/agents/a/approvals?status=pending&limit=10&offset=1" },
    { call: () => client.approve("ap1"), method: "POST", path: "/approvals/ap1/approve" },
    { call: () => client.reject("ap1"), method: "POST", path: "/approvals/ap1/reject" },
    { call: () => client.listActivity({ limit: 20, offset: 1 }), method: "GET", path: "/activity?limit=20&offset=1" },
    { call: () => client.listAgentActivity("a", { limit: 15, offset: 3 }), method: "GET", path: "/agents/a/activity?limit=15&offset=3" },
    { call: () => client.getAgentActivity("a", "act1"), method: "GET", path: "/agents/a/activity/act1" },
    { call: () => client.getPolicy("a"), method: "GET", path: "/agents/a/policy" },
    { call: () => client.updatePolicy("a", policy), method: "PUT", path: "/agents/a/policy" },
    { call: () => client.createSchedule("a", { intent, scheduleExpression: "0 * * * *" }), method: "POST", path: "/agents/a/schedules" },
    { call: () => client.listSchedules("a", { limit: 25, offset: 2 }), method: "GET", path: "/agents/a/schedules?limit=25&offset=2" },
    { call: () => client.getSchedule("a", "s1"), method: "GET", path: "/agents/a/schedules/s1" },
    { call: () => client.updateSchedule("a", "s1", { scheduleExpression: "0 1 * * *" }), method: "PATCH", path: "/agents/a/schedules/s1" },
    { call: () => client.deleteSchedule("a", "s1"), method: "DELETE", path: "/agents/a/schedules/s1" },
    { call: () => client.pauseSchedule("a", "s1"), method: "POST", path: "/agents/a/schedules/s1/pause" },
    { call: () => client.resumeSchedule("a", "s1"), method: "POST", path: "/agents/a/schedules/s1/resume" },
    { call: () => client.disableSchedule("a", "s1"), method: "POST", path: "/agents/a/schedules/s1/disable" },
    { call: () => client.listExecutions({ limit: 10, offset: 2 }), method: "GET", path: "/executions?limit=10&offset=2" },
    { call: () => client.listAgentExecutions("a", { limit: 8, offset: 4 }), method: "GET", path: "/agents/a/executions?limit=8&offset=4" },
    { call: () => client.getExecution("ex1"), method: "GET", path: "/executions/ex1" },
    { call: () => client.retryExecution("ex1"), method: "POST", path: "/executions/ex1/retry" },
    { call: () => client.cancelExecution("ex1"), method: "POST", path: "/executions/ex1/cancel" },
    { call: () => client.queueStatus(), method: "GET", path: "/agent-queue" },
    { call: () => client.getAgentSpending("a"), method: "GET", path: "/agents/a/spending" },
    { call: () => client.overviewAttention(), method: "GET", path: "/overview/attention" },
  ];

  for (const route of routes) await route.call();

  assert.equal(calls.length, routes.length);
  routes.forEach((route, index) => {
    const actual = calls[index]!;
    assert.equal(actual.url, `https://api.example.test${route.path}`);
    assert.equal(actual.method, route.method);
    assert.equal(actual.headers.get("Accept"), "application/json");
    assert.equal(actual.headers.get("Authorization"), "Bearer test-token");
  });

  assert.equal(calls[1]!.headers.get("Content-Type"), "application/json");
  assert.deepEqual(calls[1]!.body, { displayName: "bot" });
  assert.deepEqual(calls[4]!.body, { status: "paused" });
  assert.equal(calls[5]!.headers.get("Idempotency-Key"), "key-1");
  assert.deepEqual(calls[5]!.body, intent);
  assert.deepEqual(calls[15]!.body, policy);
  assert.deepEqual(calls[16]!.body, { intent, scheduleExpression: "0 * * * *" });
  assert.deepEqual(calls[19]!.body, { scheduleExpression: "0 1 * * *" });
  assert.equal(calls[20]!.headers.get("Content-Type"), null);
  assert.deepEqual(calls[21]!.body, {});
});

test("non-2xx responses throw ApiError with status and parsed payload", async () => {
  for (const [status, errorMessage] of [
    [400, "invalid input"],
    [404, "not found"],
    [409, "state conflict"],
  ] as const) {
    const { client } = setup(status, { error: errorMessage, details: ["field"] });
    await assert.rejects(client.health(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.message, errorMessage);
      assert.deepEqual(error.body, { error: errorMessage, details: ["field"] });
      assert.deepEqual(error.details, ["field"]);
      return true;
    });
  }
});

test("message-shaped API failures remain available on ApiError", async () => {
  const { client } = setup(404, { message: "approval not found", approvalId: "a1" });
  await assert.rejects(client.getApproval("a1"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 404);
    assert.equal(error.message, "approval not found");
    assert.equal(error.body.approvalId, "a1");
    return true;
  });
});

test("listAgents() with no options requests /agents with no query string", async () => {
  const { client, calls } = setup(200, { agents: [], hasMore: false, truncated: false, total: 0 });
  const result = await client.listAgents();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.example.test/agents");
  assert.equal(calls[0]!.method, "GET");
  assert.deepEqual(result, { agents: [], hasMore: false, truncated: false, total: 0 });
});

test("listAgents() exposes pagination fields from the response", async () => {
  const agents = [{ id: "a1", displayName: "A" }];
  const { client } = setup(200, { agents, hasMore: true, truncated: true, total: 3 });
  const result = await client.listAgents({ limit: 2 });
  assert.deepEqual(result.agents, agents);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 3);
});
