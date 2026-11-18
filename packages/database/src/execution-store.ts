import { DatabaseSync } from "node:sqlite";
import type { ExecutionStore, ExecutionRecord, ExecutionStatus } from "./execution-types.js";
import { getSharedConnection } from "./shared-connection.js";
import { clampOffset, clampLimit } from "./pagination.js";
import { ensureColumn, MigrationError } from "./migration.js";

const MAX_LIMIT = 200;

/**
 * InMemoryExecutionStore — process-local execution queue.
 *
 * LIMITATION: not durable. Records are lost when the process exits. This is
 * acceptable for MVP/development. Use SQLiteExecutionStore for production.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  private records = new Map<string, ExecutionRecord>();

  async record(record: ExecutionRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async getForOwner(id: string, ownerId: string): Promise<ExecutionRecord | null> {
    const rec = this.records.get(id);
    return rec?.ownerId === ownerId ? rec : null;
  }

  async listDue(before: string, limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter(
        (r) =>
          // #378: a `failed` record is only retryable when the queue itself
          // scheduled the retry (nextRetryAt set and due) AND the current
          // attempt never submitted on-chain (no submittedHash). A
          // reconciler-failed record always carries a submittedHash, so the
          // submittedHash clause is what excludes it even when it still
          // carries a stale, already-past nextRetryAt from before the
          // complete() fix — nextRetryAt alone cannot tell the two apart.
          // Operator-initiated retry() moves the record back to `queued`,
          // which this filter still picks up.
          (r.status === "queued" ||
            (r.status === "failed" && r.nextRetryAt && !r.submittedHash)) &&
          (!r.nextRetryAt || r.nextRetryAt <= before)
      )
      .sort((a, b) => (a.nextRetryAt ?? "").localeCompare(b.nextRetryAt ?? ""))
      .slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
  }

  async listByOwner(ownerId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(safeOffset, safeOffset + clampLimit(limit, MAX_LIMIT));
  }

  async listByAgent(agentId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(safeOffset, safeOffset + clampLimit(limit, MAX_LIMIT));
  }

  async listStuckExecuting(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "executing")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
  }

  async listSubmitted(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "submitted")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(limit, MAX_LIMIT)));
  }

  async countByOwner(ownerId: string): Promise<Record<ExecutionStatus, number>> {
    const counts: Record<string, number> = {};
    for (const r of this.records.values()) {
      if (r.ownerId !== ownerId) continue;
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    const result: Record<ExecutionStatus, number> = {
      queued: 0, executing: 0, submitted: 0,
      confirmed: 0, failed: 0, dead_letter: 0,
      cancelled: 0,
    };
    for (const [status, count] of Object.entries(counts)) {
      if (status in result) {
        result[status as ExecutionStatus] = count;
      }
    }
    return result;
  }

  async update(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated: ExecutionRecord = { ...existing, ...patch, id: existing.id };
    this.records.set(id, updated);
    return updated;
  }

  async updateIfStatus(id: string, expectedStatus: ExecutionStatus, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const existing = this.records.get(id);
    if (!existing || existing.status !== expectedStatus) return null;
    const updated: ExecutionRecord = { ...existing, ...patch, id: existing.id };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

/**
 * Columns writable by update() / updateIfStatus().
 *
 * `id` is deliberately absent: the primary key is immutable, matching the
 * InMemory store which re-pins `id` after merging a patch.
 */
const EXECUTION_WRITE_COLUMNS: Record<string, string> = {
  ownerId: "owner_id",
  agentId: "agent_id",
  approvalId: "approval_id",
  activityId: "activity_id",
  intent: "intent_json",
  status: "status",
  policyDecision: "policy_decision_json",
  simulationResult: "simulation_result_json",
  txHash: "tx_hash",
  submittedHash: "submitted_hash",
  error: "error",
  attempt: "attempt",
  nextRetryAt: "next_retry_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  errorClass: "error_class",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const JSON_COLUMNS = new Set(["intent_json", "policy_decision_json", "simulation_result_json"]);

/**
 * Timestamp columns compared lexicographically by listDue().
 *
 * listDue() relies on `next_retry_at <= ?` being a valid time comparison, which
 * only holds for a single canonical UTC ISO-8601 shape. Normalizing on write
 * means a caller that passes "2026-01-01T13:00:00+01:00" cannot make a retry
 * look due an hour early (or late) — an early retry is a duplicate submission.
 */
const TIMESTAMP_COLUMNS = new Set([
  "next_retry_at",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at",
]);

function toCanonicalIso(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

function encodeColumnValue(column: string, value: unknown): unknown {
  if (value === null) return null;
  if (TIMESTAMP_COLUMNS.has(column)) return toCanonicalIso(value as string);
  if (JSON_COLUMNS.has(column)) return JSON.stringify(value);
  return value;
}

interface PartialUpdate {
  /** `col = @p_col, col2 = @p_col2` */
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Build a partial SET clause from only the fields present in `patch`.
 *
 * WHY NOT read-modify-write: `update`/`updateIfStatus` used to SELECT the row,
 * merge in JS, then write every column back. Any write that lands between the
 * SELECT and the UPDATE (another API instance sharing the SQLite file, or the
 * reconciler/recovery worker in the same process) is silently reverted. For the
 * execution queue that means a retry counter, `submittedHash`, or a terminal
 * status can be rolled back — i.e. an execution retried after maxRetries or
 * resubmitted after it was already submitted. Writing only the caller's fields
 * in one statement removes the window entirely.
 *
 * `undefined` values are skipped ("field not supplied"); explicit `null` clears.
 */
function buildPartialUpdate(patch: Partial<ExecutionRecord>): PartialUpdate | null {
  const assignments: string[] = [];
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    // hasOwnProperty guard: a `__proto__`/`constructor` key from an untrusted
    // patch must not resolve to an inherited value and end up in the SET clause.
    if (!Object.prototype.hasOwnProperty.call(EXECUTION_WRITE_COLUMNS, key)) continue;
    const column = EXECUTION_WRITE_COLUMNS[key];
    if (!column || value === undefined) continue;
    const param = `p_${column}`;
    assignments.push(`${column} = @${param}`);
    params[param] = encodeColumnValue(column, value);
  }
  if (assignments.length === 0) return null;
  return { sql: assignments.join(", "), params };
}

interface ExecutionRow {
  id: string;
  owner_id: string;
  agent_id: string;
  approval_id: string | null;
  activity_id: string | null;
  intent_json: string;
  status: string;
  policy_decision_json: string | null;
  simulation_result_json: string | null;
  tx_hash: string | null;
  submitted_hash: string | null;
  error: string | null;
  attempt: number;
  next_retry_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_class: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SQLiteExecutionStore — persistent ExecutionStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+). Schema versioned in _meta
 * (version 1). initSchema() is idempotent. Records survive process restart.
 */
export class SQLiteExecutionStore implements ExecutionStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    // #401: any failure creating the base schema must also fail loudly
    // with the table named, never silently start on a broken database.
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        approval_id TEXT,
        activity_id TEXT,
        intent_json TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_decision_json TEXT,
        simulation_result_json TEXT,
        tx_hash TEXT,
        submitted_hash TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        error_class TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_executions_owner ON executions(owner_id);
      CREATE INDEX IF NOT EXISTS idx_executions_agent ON executions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);
      CREATE INDEX IF NOT EXISTS idx_executions_next_retry ON executions(next_retry_at);
    `);
    } catch (err) {
      throw new MigrationError("executions", null, err);
    }
    // #401: this used to be a bare try/catch that swallowed every failure
    // (locked database, I/O error, ...) as "column already exists". The
    // migration now checks first and throws MigrationError on any other
    // failure, so startup aborts instead of starting half-migrated.
    ensureColumn(this.db, "executions", "submitted_hash", "TEXT");
  }

  async record(record: ExecutionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO executions
         (id, owner_id, agent_id, approval_id, activity_id, intent_json, status,
          policy_decision_json, simulation_result_json, tx_hash, submitted_hash, error, attempt,
          next_retry_at, started_at, completed_at, error_class, created_at, updated_at)
         VALUES
         (@id, @owner_id, @agent_id, @approval_id, @activity_id, @intent_json, @status,
          @policy_decision_json, @simulation_result_json, @tx_hash, @submitted_hash, @error, @attempt,
          @next_retry_at, @started_at, @completed_at, @error_class, @created_at, @updated_at)`
      )
      .run({
        id: record.id,
        owner_id: record.ownerId,
        agent_id: record.agentId,
        approval_id: record.approvalId,
        activity_id: record.activityId,
        intent_json: JSON.stringify(record.intent),
        status: record.status,
        policy_decision_json: record.policyDecision ? JSON.stringify(record.policyDecision) : null,
        simulation_result_json: record.simulationResult ? JSON.stringify(record.simulationResult) : null,
        tx_hash: record.txHash,
        submitted_hash: record.submittedHash ?? null,
        error: record.error,
        attempt: record.attempt,
        next_retry_at: toCanonicalIso(record.nextRetryAt),
        started_at: toCanonicalIso(record.startedAt),
        completed_at: toCanonicalIso(record.completedAt),
        error_class: record.errorClass,
        created_at: toCanonicalIso(record.createdAt),
        updated_at: toCanonicalIso(record.updatedAt),
      });
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as unknown as ExecutionRow | undefined;
    return row ? rowToExecutionRecord(row) : null;
  }

  async getForOwner(id: string, ownerId: string): Promise<ExecutionRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM executions WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as unknown as ExecutionRow | undefined;
    return row ? rowToExecutionRecord(row) : null;
  }

  async listDue(before: string, limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const rows = this.db
      .prepare(
        `SELECT * FROM executions
         WHERE (status = 'queued' OR (status = 'failed' AND next_retry_at IS NOT NULL AND submitted_hash IS NULL))
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY next_retry_at ASC
         LIMIT ?`
      )
      .all(before, safeLimit) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listByOwner(ownerId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeLimit = clampLimit(limit, MAX_LIMIT);
    const safeOffset = clampOffset(offset);
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(ownerId, safeLimit, safeOffset) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listByAgent(agentId: string, limit = MAX_LIMIT, offset = 0): Promise<ExecutionRecord[]> {
    const safeLimit = clampLimit(limit, MAX_LIMIT);
    const safeOffset = clampOffset(offset);
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(agentId, safeLimit, safeOffset) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listStuckExecuting(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE status = 'executing' ORDER BY created_at ASC LIMIT ?")
      .all(safeLimit) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async listSubmitted(limit = MAX_LIMIT): Promise<ExecutionRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
    const rows = this.db
      .prepare("SELECT * FROM executions WHERE status = 'submitted' ORDER BY created_at ASC LIMIT ?")
      .all(safeLimit) as unknown as ExecutionRow[];
    return rows.map(rowToExecutionRecord);
  }

  async countByOwner(ownerId: string): Promise<Record<ExecutionStatus, number>> {
    const rows = this.db
      .prepare(
        "SELECT status, COUNT(*) as count FROM executions WHERE owner_id = ? GROUP BY status"
      )
      .all(ownerId) as unknown as Array<{ status: string; count: number }>;
    const result: Record<ExecutionStatus, number> = {
      queued: 0, executing: 0, submitted: 0,
      confirmed: 0, failed: 0, dead_letter: 0,
      cancelled: 0,
    };
    for (const row of rows) {
      const s = row.status as ExecutionStatus;
      if (s in result) result[s] = row.count;
    }
    return result;
  }

  async update(id: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const partial = buildPartialUpdate(patch);
    // No writable fields supplied — mirror the InMemory store, which returns the
    // record unchanged (or null when it does not exist).
    if (!partial) return this.get(id);

    const result = this.db
      .prepare(`UPDATE executions SET ${partial.sql} WHERE id = @id`)
      .run({ ...partial.params, id });
    if (Number(result.changes) === 0) return null;

    // Re-read so callers observe what is actually persisted, not a local merge
    // that a concurrent writer may already have superseded.
    return this.get(id);
  }

  async updateIfStatus(id: string, expectedStatus: ExecutionStatus, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord | null> {
    const partial = buildPartialUpdate(patch);
    if (!partial) {
      const row = this.db
        .prepare("SELECT * FROM executions WHERE id = ? AND status = ?")
        .get(id, expectedStatus) as unknown as ExecutionRow | undefined;
      return row ? rowToExecutionRecord(row) : null;
    }

    // Single-statement compare-and-swap: the status guard is evaluated by
    // SQLite in the same statement that writes, so exactly one concurrent
    // claimer can win and no other column is overwritten.
    const result = this.db
      .prepare(`UPDATE executions SET ${partial.sql} WHERE id = @id AND status = @expected_status`)
      .run({ ...partial.params, id, expected_status: expectedStatus });
    if (Number(result.changes) === 0) return null;

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM executions WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  close(): void {
    // Shared connection — managed by closeSharedConnection() / closeAllSharedConnections()
  }
}

function rowToExecutionRecord(r: ExecutionRow): ExecutionRecord {
  return {
    id: r.id,
    ownerId: r.owner_id,
    agentId: r.agent_id,
    approvalId: r.approval_id,
    activityId: r.activity_id,
    intent: JSON.parse(r.intent_json),
    status: r.status as ExecutionRecord["status"],
    policyDecision: r.policy_decision_json ? JSON.parse(r.policy_decision_json) : null,
    simulationResult: r.simulation_result_json ? JSON.parse(r.simulation_result_json) : null,
    txHash: r.tx_hash,
    submittedHash: r.submitted_hash,
    error: r.error,
    attempt: r.attempt,
    nextRetryAt: r.next_retry_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    errorClass: r.error_class,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
