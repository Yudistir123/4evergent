// Empty-string VITE_API_BASE (e.g. left blank in a deployment env panel) must
// fall back to the local dev API — '' would silently make every request a
// same-origin SPA fetch that returns index.html.
const API_BASE = import.meta.env.VITE_API_BASE?.trim() || 'http://localhost:3000';
import { getStoredToken, clearAuth } from './auth';

export class ApiError extends Error {
  status: number;
  /** Machine-readable error code from the API; 'UNKNOWN' when the server sent none. */
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'UNKNOWN', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Requests carry:
 *  - credentials: include → the HttpOnly session cookie (user login)
 *  - X-Requested-With → CSRF guard for cookie-authenticated state changes
 *  - legacy Bearer token if one is stored (API-key/CLI consumers only;
 *    browser user login never sets it)
 */
async function request<T>(path: string, init?: RequestInit & { skipAuthClear?: boolean }): Promise<T> {
  const { skipAuthClear, ...fetchInit } = init ?? {};
  const headers = new Headers(fetchInit.headers);
  if (!headers.has('Content-Type') && fetchInit.body != null) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('X-Requested-With', '4evergent');
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    keepalive: false,
    ...fetchInit,
    headers,
  });
  const body = res.status !== 204 ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const message = body?.error ?? `API error ${res.status}`;
    // Probes (e.g. /auth/me during session bootstrap) must not wipe a stored
    // legacy bearer token — the caller decides how to handle 401.
    if (res.status === 401 && !skipAuthClear) {
      clearAuth();
    }
    throw new ApiError(res.status, message, body?.code ?? 'UNKNOWN', body?.details);
  }
  return body as T;
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

import type {
  AgentRecord,
  ActivityRecord,
  ApprovalRecord,
  SubmitPaymentIntent,
  SubmitTrustlineIntent,
  ScheduleRecord,
  ExecutionRecord,
  QueueSummary,
  PolicyRules,
} from './types';

export interface IntentResponse {
  activityId: string;
  agentId: string;
  status: string;
  policyDecision: {
    result: string;
    reason: string;
    rule: string;
    intent: any;
  };
  authorizationStatus: string;
  simulationResult: any;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

export const api = {
  health: () => request<{ status: string; signerAccountId: string }>('/health'),

  listAgents: (limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const query = params.toString();
    return request<{ agents: AgentRecord[]; hasMore: boolean; truncated: boolean; total: number }>(
      `/agents${query ? `?${query}` : ''}`
    );
  },

  /**
   * Load the owner's full agent list by paging through GET /agents.
   * The API caps a single page at 200 rows, so one call can silently drop
   * the oldest agents; this walks every page instead. `truncated` is true
   * only when the walk stopped early at the API's offset ceiling (10_000),
   * i.e. loaded agents are fewer than the server-reported total.
   */
  listAllAgents: async () => {
    const PAGE_SIZE = 200;
    const agents: AgentRecord[] = [];
    let offset = 0;
    let total = 0;
    for (;;) {
      const page = await api.listAgents(PAGE_SIZE, offset);
      agents.push(...page.agents);
      total = page.total;
      if (!page.hasMore) break;
      offset += page.agents.length;
      // Guard against a server that keeps reporting hasMore without
      // advancing the page (would loop forever appending duplicates).
      if (page.agents.length === 0) break;
    }
    return { agents, total, truncated: agents.length < total };
  },

  getAgent: (agentId: string) => request<AgentRecord>(`/agents/${encodeURIComponent(agentId)}`),

  agentActivity: (agentId: string, limit = 50, offset = 0) =>
    request<{ agentId: string; activity: ActivityRecord[]; hasMore: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}&offset=${offset}`
    ),

  activityDetail: (agentId: string, activityId: string) =>
    request<{ activity: ActivityRecord }>(`/agents/${encodeURIComponent(agentId)}/activity/${encodeURIComponent(activityId)}`),

  agentApprovals: (agentId: string, statusFilter?: string) => {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    return request<{ agentId: string; approvals: ApprovalRecord[] }>(`/agents/${encodeURIComponent(agentId)}/approvals${qs}`);
  },

  updateAgentStatus: (agentId: string, status: string) =>
    request<{ id: string; status: string }>(`/agents/${encodeURIComponent(agentId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  // ===== Policy =====

  getPolicy: (agentId: string) =>
    request<{ agentId: string; policy: PolicyRules; version: number; updatedAt: string | null }>(
      `/agents/${encodeURIComponent(agentId)}/policy`
    ),

  getAgentSpending: (agentId: string) =>
    request<{ agentId: string; spending: Record<string, { used: number; limit: string; remaining: number }> }>(
      `/agents/${encodeURIComponent(agentId)}/spending`
    ),

  updatePolicy: (agentId: string, policy: Partial<PolicyRules>) =>
    request<{ agentId: string; policy: PolicyRules; version: number }>(
      `/agents/${encodeURIComponent(agentId)}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify(policy),
      },
    ),

  listApprovals: (statusFilter?: string, limit = 50, offset = 0) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return request<{ approvals: ApprovalRecord[]; hasMore: boolean; truncated: boolean; total: number }>(`/approvals?${params}`);
  },

  approvalDetail: (approvalId: string) =>
    request<{ approval: ApprovalRecord }>(`/approvals/${encodeURIComponent(approvalId)}`),

  approve: (approvalId: string) =>
    request<{ approvalId: string; activityId: string; status: string; message: string }>(
      `/approvals/${encodeURIComponent(approvalId)}/approve`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  reject: (approvalId: string) =>
    request<{ approvalId: string; activityId: string; status: string; message: string }>(
      `/approvals/${encodeURIComponent(approvalId)}/reject`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  submitPayment: (agentId: string, intent: SubmitPaymentIntent) =>
    request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: 'POST',
      body: JSON.stringify(intent),
    }),

  submitTrustline: (agentId: string, intent: SubmitTrustlineIntent) =>
    request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: 'POST',
      body: JSON.stringify({ ...intent, type: 'trustline' }),
    }),

  createAgent: (body: { displayName: string; description?: string; capabilities?: string[]; stellarAddress?: string }) =>
    request<{ agent: AgentRecord }>('/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== Executions =====

  listAllExecutions: (limit = 50, offset = 0) =>
    request<{ executions: ExecutionRecord[]; hasMore: boolean }>(
      `/executions?limit=${limit}&offset=${offset}`
    ),

  listActivity: (limit = 50, offset = 0) =>
    request<{ activity: ActivityRecord[]; hasMore: boolean }>(
      `/activity?limit=${limit}&offset=${offset}`
    ),

  listAgentExecutions: (agentId: string, limit = 50, offset = 0) =>
    request<{ agentId: string; executions: ExecutionRecord[]; hasMore: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/executions?limit=${limit}&offset=${offset}`
    ),

  getExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord }>(`/executions/${encodeURIComponent(executionId)}`),

  getQueueStatus: () =>
    request<QueueSummary>('/agent-queue'),

  getOverviewAttention: () =>
    request<{
      pendingApprovals: number;
      failedExecutions: number;
      deadLetterExecutions: number;
      retryingExecutions: number;
      stuckExecutions: number;
    }>('/overview/attention'),

  retryExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord; message: string }>(
      `/executions/${encodeURIComponent(executionId)}/retry`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  cancelExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord; message: string }>(
      `/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  // ===== Schedules =====

  listSchedules: (agentId: string, limit = 50, offset = 0) =>
    request<{ agentId: string; schedules: ScheduleRecord[]; hasMore: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/schedules?limit=${limit}&offset=${offset}`
    ),

  getSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`
    ),

  createSchedule: (agentId: string, body: { intent: any; scheduleExpression: string; timezone?: string }) =>
    request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateSchedule: (agentId: string, scheduleId: string, body: { scheduleExpression?: string }) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'PATCH', body: JSON.stringify(body) }
    ),

  deleteSchedule: (agentId: string, scheduleId: string) =>
    request<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'DELETE' }
    ),

  pauseSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/pause`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  resumeSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/resume`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  disableSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/disable`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  // ===== User authentication (session cookie; no Bearer API key needed) =====

  authConfig: () =>
    request<{ email: boolean; google: boolean; stellar: boolean; registration: boolean }>(
      `/auth/config`
    ),

  me: () =>
    request<{ subject: string; ownerId: string; method: string; displayName: string; email: string | null }>(
      `/auth/me`,
      { skipAuthClear: true }
    ),

  register: (body: { email: string; password: string; displayName?: string }) =>
    request<{ subject: string }>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  loginEmail: (body: { email: string; password: string }) =>
    request<{ subject: string }>('/auth/login/email', { method: 'POST', body: JSON.stringify(body) }),

  stellarChallenge: (publicKey: string) =>
    request<{ challengeId: string; message: string; expiresAt: string; network: string }>(
      '/auth/stellar/challenge',
      { method: 'POST', body: JSON.stringify({ publicKey }) }
    ),

  stellarVerify: (body: { publicKey: string; challengeId: string; signature: string }) =>
    request<{ subject: string }>('/auth/stellar/verify', { method: 'POST', body: JSON.stringify(body) }),

  logout: () => request<null>('/auth/logout', { method: 'POST' }),

  /** Full-page navigation target for the Google OAuth start (server-side flow). */
  authStartUrl: () => `${API_BASE}/auth/google/start`,
};
