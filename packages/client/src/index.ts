import type {
  ActivityRecord,
  Agent,
  AgentIntent,
  AgentStatus,
  AuthorizationStatus,
  CreateAgentInput,
  PolicyDecision,
  PolicyRules,
  ScheduleStatus,
  SimulationResult,
} from "@4evergent/shared";

export type {
  ActivityRecord,
  Agent,
  AgentIntent,
  AgentStatus,
  PolicyDecision,
  PolicyRules,
  ScheduleStatus,
};

export interface ClientOptions {
  /** API origin, for example `https://api.example.com` or `http://localhost:3000`. */
  baseUrl: string;
  /** Optional API key or bearer token. */
  token?: string;
  /** Override the platform fetch implementation, primarily for tests. */
  fetch?: typeof globalThis.fetch;
}

export type CreateAgentBody = Omit<CreateAgentInput, "ownerId">;

export type AgentSummary = Pick<
  Agent,
  "id" | "displayName" | "description" | "ownerId" | "stellarAddress" | "capabilities" | "status" | "active" | "createdAt"
>;

export type AgentDetails = Omit<Agent, "metadata">;

export interface IntentResponse {
  activityId: string;
  agentId: string;
  status: ActivityRecord["status"];
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed";

export interface ApprovalRecord {
  id: string;
  activityId: string;
  agentId: string;
  ownerId: string;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  status: ApprovalStatus;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  approver: string | null;
  expiresAt: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExecutionStatus = "queued" | "executing" | "submitted" | "confirmed" | "failed" | "dead_letter";

export interface ExecutionRecord {
  id: string;
  ownerId: string;
  agentId: string;
  approvalId: string | null;
  activityId: string | null;
  intent: AgentIntent;
  status: ExecutionStatus;
  policyDecision: PolicyDecision | null;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  submittedHash: string | null;
  error: string | null;
  attempt: number;
  nextRetryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorClass: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRecord {
  id: string;
  agentId: string;
  ownerId: string;
  status: ScheduleStatus;
  intent: AgentIntent;
  scheduleExpression: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleBody {
  intent: AgentIntent;
  scheduleExpression: string;
  timezone?: string;
}

export interface UpdateScheduleBody {
  scheduleExpression?: string;
}

export interface ApprovalActionResponse {
  approvalId: string;
  activityId: string;
  agentId: string;
  status: ApprovalStatus;
  message: string;
}

export interface QueueSummary {
  running: boolean;
  byStatus: Record<string, number>;
}

export interface OverviewAttention {
  pendingApprovals: number;
  failedExecutions: number;
  deadLetterExecutions: number;
  retryingExecutions: number;
  stuckExecutions: number;
}

export interface AgentSpending {
  agentId: string;
  spending: Record<string, { used: number; limit: string; remaining: number }>;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
  [key: string]: unknown;
}

/** An HTTP error returned by the 4evergent API. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    const message = body.error ?? body.message ?? `API request failed with status ${status}`;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.details = body.details;
  }
}

export interface RequestOptions {
  limit?: number;
  offset?: number;
}

export interface ApprovalListOptions extends RequestOptions {
  status?: string;
}

export interface SubmitIntentOptions {
  idempotencyKey?: string;
}

function withPagination(path: string, options: RequestOptions = {}): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class Client {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    const baseUrl = options.baseUrl.trim();
    if (!baseUrl) throw new TypeError("baseUrl is required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required (Node.js 22+ provides fetch)");
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (response.status === 204) return undefined as T;

    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as ApiErrorBody
        : {};
      throw new ApiError(response.status, body);
    }
    return parsed as T;
  }

  health(): Promise<{ status: string; signerAccountId: string }> {
    return this.request<{ status: string; signerAccountId: string }>("/health");
  }

  createAgent(body: CreateAgentBody): Promise<{ agent: Agent }> {
    return this.request<{ agent: Agent }>("/agents", { method: "POST", body: JSON.stringify(body) });
  }

  listAgents(options: RequestOptions = {}): Promise<{
    agents: AgentSummary[];
    hasMore: boolean;
    truncated: boolean;
    total: number;
  }> {
    return this.request<{
      agents: AgentSummary[];
      hasMore: boolean;
      truncated: boolean;
      total: number;
    }>(withPagination("/agents", options));
  }

  getAgent(agentId: string): Promise<AgentDetails> {
    return this.request<AgentDetails>(`/agents/${encodeURIComponent(agentId)}`);
  }

  updateAgentStatus(agentId: string, status: AgentStatus): Promise<{ id: string; status: AgentStatus }> {
    return this.request<{ id: string; status: AgentStatus }>(`/agents/${encodeURIComponent(agentId)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  submitIntent(agentId: string, intent: AgentIntent, options: SubmitIntentOptions = {}): Promise<IntentResponse> {
    const headers = new Headers();
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    return this.request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(intent),
    });
  }

  listApprovals(options: ApprovalListOptions = {}): Promise<{ approvals: ApprovalRecord[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request<{ approvals: ApprovalRecord[]; hasMore: boolean }>(`/approvals${query ? `?${query}` : ""}`);
  }

  getApproval(approvalId: string): Promise<{ approval: ApprovalRecord }> {
    return this.request<{ approval: ApprovalRecord }>(`/approvals/${encodeURIComponent(approvalId)}`);
  }

  listAgentApprovals(agentId: string, options: ApprovalListOptions = {}): Promise<{ agentId: string; approvals: ApprovalRecord[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request<{ agentId: string; approvals: ApprovalRecord[]; hasMore: boolean }>(`/agents/${encodeURIComponent(agentId)}/approvals${query ? `?${query}` : ""}`);
  }

  approve(approvalId: string): Promise<ApprovalActionResponse> {
    return this.request<ApprovalActionResponse>(`/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  reject(approvalId: string): Promise<ApprovalActionResponse> {
    return this.request<ApprovalActionResponse>(`/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  listAgentActivity(agentId: string, options: RequestOptions = {}): Promise<{ agentId: string; activity: ActivityRecord[]; hasMore?: boolean }> {
    return this.request<{ agentId: string; activity: ActivityRecord[]; hasMore: boolean }>(withPagination(`/agents/${encodeURIComponent(agentId)}/activity`, options));
  }

  getAgentActivity(agentId: string, activityId: string): Promise<{ activity: ActivityRecord }> {
    return this.request<{ activity: ActivityRecord }>(`/agents/${encodeURIComponent(agentId)}/activity/${encodeURIComponent(activityId)}`);
  }

  listActivity(options: RequestOptions = {}): Promise<{ activity: ActivityRecord[]; hasMore?: boolean }> {
    return this.request<{ activity: ActivityRecord[]; hasMore: boolean }>(withPagination("/activity", options));
  }

  getPolicy(agentId: string): Promise<{ agentId: string; policy: PolicyRules; version: number; updatedAt: string | null }> {
    return this.request<{ agentId: string; policy: PolicyRules; version: number; updatedAt: string | null }>(`/agents/${encodeURIComponent(agentId)}/policy`);
  }

  updatePolicy(agentId: string, policy: Partial<PolicyRules>): Promise<{ agentId: string; policy: PolicyRules; version: number }> {
    return this.request<{ agentId: string; policy: PolicyRules; version: number }>(`/agents/${encodeURIComponent(agentId)}/policy`, {
      method: "PUT",
      body: JSON.stringify(policy),
    });
  }

  createSchedule(agentId: string, body: CreateScheduleBody): Promise<{ schedule: ScheduleRecord }> {
    return this.request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  listSchedules(agentId: string, options: RequestOptions = {}): Promise<{ agentId: string; schedules: ScheduleRecord[]; hasMore?: boolean }> {
    return this.request<{ agentId: string; schedules: ScheduleRecord[]; hasMore: boolean }>(withPagination(`/agents/${encodeURIComponent(agentId)}/schedules`, options));
  }

  getSchedule(agentId: string, scheduleId: string): Promise<{ schedule: ScheduleRecord }> {
    return this.request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`);
  }

  updateSchedule(agentId: string, scheduleId: string, body: UpdateScheduleBody): Promise<{ schedule: ScheduleRecord }> {
    return this.request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  deleteSchedule(agentId: string, scheduleId: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
    });
  }

  pauseSchedule(agentId: string, scheduleId: string): Promise<{ schedule: ScheduleRecord }> {
    return this.scheduleAction(agentId, scheduleId, "pause");
  }

  resumeSchedule(agentId: string, scheduleId: string): Promise<{ schedule: ScheduleRecord }> {
    return this.scheduleAction(agentId, scheduleId, "resume");
  }

  disableSchedule(agentId: string, scheduleId: string): Promise<{ schedule: ScheduleRecord }> {
    return this.scheduleAction(agentId, scheduleId, "disable");
  }

  private scheduleAction(agentId: string, scheduleId: string, action: "pause" | "resume" | "disable"): Promise<{ schedule: ScheduleRecord }> {
    return this.request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  listAgentExecutions(agentId: string, options: RequestOptions = {}): Promise<{ agentId: string; executions: ExecutionRecord[]; hasMore?: boolean }> {
    return this.request<{ agentId: string; executions: ExecutionRecord[]; hasMore: boolean }>(withPagination(`/agents/${encodeURIComponent(agentId)}/executions`, options));
  }

  listExecutions(options: RequestOptions = {}): Promise<{ executions: ExecutionRecord[]; hasMore?: boolean }> {
    return this.request<{ executions: ExecutionRecord[]; hasMore: boolean }>(withPagination("/executions", options));
  }

  getExecution(executionId: string): Promise<{ execution: ExecutionRecord }> {
    return this.request<{ execution: ExecutionRecord }>(`/executions/${encodeURIComponent(executionId)}`);
  }

  retryExecution(executionId: string): Promise<{ execution: ExecutionRecord; message: string }> {
    return this.request<{ execution: ExecutionRecord; message: string }>(`/executions/${encodeURIComponent(executionId)}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  cancelExecution(executionId: string): Promise<{ execution: ExecutionRecord; message: string }> {
    return this.request<{ execution: ExecutionRecord; message: string }>(`/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  queueStatus(): Promise<QueueSummary> {
    return this.request<QueueSummary>("/agent-queue");
  }

  getAgentSpending(agentId: string): Promise<AgentSpending> {
    return this.request<AgentSpending>(`/agents/${encodeURIComponent(agentId)}/spending`);
  }

  overviewAttention(): Promise<OverviewAttention> {
    return this.request<OverviewAttention>("/overview/attention");
  }
}

export function createClient(options: ClientOptions): Client {
  return new Client(options);
}
