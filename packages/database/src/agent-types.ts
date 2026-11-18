import type { Agent } from "@4evergent/shared";
import type { AgentStatus } from "@4evergent/shared";

export interface CreateAgentInput {
  id?: string;
  displayName: string;
  description?: string;
  capabilities?: string[];
  ownerId: string;
  stellarAddress?: string;
  status?: "active" | "paused" | "disabled";
}

export type AgentStatusTransitionResult =
  | { updated: true; agent: Agent }
  | { updated: false; reason: "not_found" }
  | { updated: false; reason: "invalid_transition"; currentStatus: AgentStatus };

const ALLOWED_PREVIOUS_STATUSES: Record<AgentStatus, readonly AgentStatus[]> = {
  active: ["paused"],
  paused: ["active"],
  disabled: ["active", "paused"],
};

export function getAllowedPreviousAgentStatuses(status: AgentStatus): readonly AgentStatus[] {
  return ALLOWED_PREVIOUS_STATUSES[status];
}

export interface AgentStore {
  create(input: CreateAgentInput): Promise<Agent>;
  get(id: string): Promise<Agent | null>;
  getForOwner(id: string, ownerId: string): Promise<Agent | null>;
  listByOwner(ownerId: string, limit?: number, offset?: number): Promise<Agent[]>;
  listByCapability(ownerId: string, capability: string, limit?: number, offset?: number): Promise<Agent[]>;
  /** Total agents owned by `ownerId` (no limit/offset applied). */
  countByOwner(ownerId: string): Promise<number>;
  /** Total agents owned by `ownerId` with the given capability. */
  countByCapability(ownerId: string, capability: string): Promise<number>;
  update(id: string, patch: Partial<Agent>): Promise<Agent | null>;
  transitionStatus(id: string, status: AgentStatus): Promise<AgentStatusTransitionResult>;
  delete(id: string): Promise<boolean>;
}
