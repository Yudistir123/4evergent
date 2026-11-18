import { DatabaseSync } from "node:sqlite";
import type { Agent, AgentStatus } from "@4evergent/shared";
import { getSharedConnection } from "./shared-connection.js";
import { clampOffset } from "./pagination.js";
import { getAllowedPreviousAgentStatuses, type AgentStatusTransitionResult, type AgentStore, type CreateAgentInput } from "./agent-types.js";

export const MAX_LIMIT = 200;

/**
 * InMemoryAgentStore — process-local agent storage.
 *
 * LIMITATION: not durable. Records are lost when the process exits. This is
 * acceptable for MVP/development. Use SQLiteAgentStore for production.
 */
export class InMemoryAgentStore implements AgentStore {
  private records = new Map<string, Agent>();

  async create(input: CreateAgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    const agent: Agent = {
      id: input.id ?? crypto.randomUUID(),
      displayName: input.displayName,
      description: input.description ?? "",
      ownerId: input.ownerId,
      stellarAddress: input.stellarAddress ?? "",
      capabilities: input.capabilities ?? [],
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      active: (input.status ?? "active") === "active",
      metadata: {},
    };
    this.records.set(agent.id, agent);
    return agent;
  }

  async get(id: string): Promise<Agent | null> {
    return this.records.get(id) ?? null;
  }

  async getForOwner(id: string, ownerId: string): Promise<Agent | null> {
    const rec = this.records.get(id);
    return rec?.ownerId === ownerId ? rec : null;
  }

  async listByOwner(ownerId: string, limit = MAX_LIMIT, offset = 0): Promise<Agent[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + safeLimit);
  }

  async listByCapability(
    ownerId: string,
    capability: string,
    limit = MAX_LIMIT,
    offset = 0
  ): Promise<Agent[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId && (r.capabilities ?? []).includes(capability))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + safeLimit);
  }

  async countByOwner(ownerId: string): Promise<number> {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.ownerId === ownerId) n++;
    }
    return n;
  }

  async countByCapability(ownerId: string, capability: string): Promise<number> {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.ownerId === ownerId && (r.capabilities ?? []).includes(capability)) n++;
    }
    return n;
  }

  async update(id: string, patch: Partial<Agent>): Promise<Agent | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated: Agent = { ...existing, ...patch, id: existing.id };
    if (patch.status !== undefined) {
      updated.active = patch.status === "active";
    }
    this.records.set(id, updated);
    return updated;
  }

  async transitionStatus(id: string, status: AgentStatus): Promise<AgentStatusTransitionResult> {
    const existing = this.records.get(id);
    if (!existing) return { updated: false, reason: "not_found" };
    if (!getAllowedPreviousAgentStatuses(status).includes(existing.status)) {
      return { updated: false, reason: "invalid_transition", currentStatus: existing.status };
    }

    const updated: Agent = {
      ...existing,
      status,
      active: status === "active",
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, updated);
    return { updated: true, agent: updated };
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

interface AgentRow {
  id: string;
  display_name: string;
  description: string;
  owner_id: string;
  stellar_address: string;
  capabilities_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  active: number;
  metadata_json: string;
}

/**
 * SQLiteAgentStore — persistent AgentStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+). Schema versioned in _meta
 * (schema_version = 1). initSchema() is idempotent. Records survive process
 * restart.
 */
export class SQLiteAgentStore implements AgentStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_id TEXT NOT NULL,
        stellar_address TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    `);
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    const agent: Agent = {
      id: input.id ?? crypto.randomUUID(),
      displayName: input.displayName,
      description: input.description ?? "",
      ownerId: input.ownerId,
      stellarAddress: input.stellarAddress ?? "",
      capabilities: input.capabilities ?? [],
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      active: (input.status ?? "active") === "active",
      metadata: {},
    };
    this.db
      .prepare(
        `INSERT INTO agents
         (id, display_name, description, owner_id, stellar_address, capabilities_json,
          status, created_at, updated_at, active, metadata_json)
         VALUES
         (@id, @display_name, @description, @owner_id, @stellar_address, @capabilities_json,
          @status, @created_at, @updated_at, @active, @metadata_json)`
      )
      .run({
        id: agent.id,
        display_name: agent.displayName,
        description: agent.description,
        owner_id: agent.ownerId,
        stellar_address: agent.stellarAddress,
        capabilities_json: JSON.stringify(agent.capabilities),
        status: agent.status,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
        active: agent.active ? 1 : 0,
        metadata_json: JSON.stringify(agent.metadata),
      } as any);
    return agent;
  }

  async get(id: string): Promise<Agent | null> {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  async getForOwner(id: string, ownerId: string): Promise<Agent | null> {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as unknown as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  async listByOwner(ownerId: string, limit = MAX_LIMIT, offset = 0): Promise<Agent[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const safeOffset = clampOffset(offset);
    const rows = this.db
      .prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(ownerId, safeLimit, safeOffset) as unknown as AgentRow[];
    return rows.map(rowToAgent);
  }

  async listByCapability(
    ownerId: string,
    capability: string,
    limit = MAX_LIMIT,
    offset = 0
  ): Promise<Agent[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const safeOffset = clampOffset(offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM agents
         WHERE owner_id = ?
           AND json_valid(capabilities_json)
           AND EXISTS (SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = ?)
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(ownerId, capability, safeLimit, safeOffset) as unknown as AgentRow[];
    return rows.map(rowToAgent);
  }

  async countByOwner(ownerId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM agents WHERE owner_id = ?")
      .get(ownerId) as unknown as { count: number };
    return row.count;
  }

  async countByCapability(ownerId: string, capability: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM agents
         WHERE owner_id = ?
           AND json_valid(capabilities_json)
           AND EXISTS (SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = ?)`
      )
      .get(ownerId, capability) as unknown as { count: number };
    return row.count;
  }

  async update(id: string, patch: Partial<Agent>): Promise<Agent | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: Agent = { ...existing, ...patch, id: existing.id };
    if (patch.status !== undefined) {
      updated.active = patch.status === "active";
    }
    updated.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agents SET
           display_name = @display_name, description = @description,
           owner_id = @owner_id, stellar_address = @stellar_address,
           capabilities_json = @capabilities_json, status = @status,
           updated_at = @updated_at, active = @active, metadata_json = @metadata_json
         WHERE id = @id`
      )
      .run({
        id: updated.id,
        display_name: updated.displayName,
        description: updated.description,
        owner_id: updated.ownerId,
        stellar_address: updated.stellarAddress,
        capabilities_json: JSON.stringify(updated.capabilities),
        status: updated.status,
        updated_at: updated.updatedAt,
        active: updated.active ? 1 : 0,
        metadata_json: JSON.stringify(updated.metadata),
      } as any);
    return updated;
  }

  async transitionStatus(id: string, status: AgentStatus): Promise<AgentStatusTransitionResult> {
    const allowedPreviousStatuses = getAllowedPreviousAgentStatuses(status);
    const placeholders = allowedPreviousStatuses.map(() => "?").join(", ");
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE agents
         SET status = ?, active = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`
      )
      .run(status, status === "active" ? 1 : 0, now, id, ...allowedPreviousStatuses);

    if (result.changes > 0) {
      const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as unknown as AgentRow | undefined;
      if (row) return { updated: true, agent: rowToAgent(row) };
    }

    const current = await this.get(id);
    if (!current) return { updated: false, reason: "not_found" };
    return { updated: false, reason: "invalid_transition", currentStatus: current.status };
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    // Shared connection — managed by closeSharedConnection() / closeAllSharedConnections()
  }
}

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    displayName: r.display_name,
    description: r.description,
    ownerId: r.owner_id,
    stellarAddress: r.stellar_address,
    capabilities: JSON.parse(r.capabilities_json),
    status: r.status as Agent["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    active: r.active === 1,
    metadata: JSON.parse(r.metadata_json),
  };
}
