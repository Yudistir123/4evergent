import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SQLiteActivityStore } from "../src/sqlite-store.js";
import { SQLiteExecutionStore } from "../src/execution-store.js";
import { SQLiteScheduleStore } from "../src/schedule-store.js";
import {
  MigrationError,
  ensureColumn,
  ensureTable,
  tableExists,
  tableHasColumn,
} from "../src/migration.js";
import { closeAllSharedConnections } from "../src/shared-connection.js";

// Issue #401: failed schema migrations must fail startup loudly instead of
// being swallowed by bare try/catch blocks.

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-test-"));
  tmpDirs.push(dir);
  return dir;
}

function cleanup(): void {
  closeAllSharedConnections();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name
  );
}

/** Legacy executions table as created before `submitted_hash` existed. */
function createLegacyExecutions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE executions (
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
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      error_class TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/** Legacy schedules table as created before `last_started_at` existed. */
function createLegacySchedules(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      schedule_expression TEXT NOT NULL,
      timezone TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

test("migration helpers: already-migrated state is a clean no-op", () => {
  const dbPath = join(makeTmpDir(), "noop.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE executions (id TEXT PRIMARY KEY, submitted_hash TEXT);`);
    assert.equal(tableHasColumn(db, "executions", "submitted_hash"), true);
    assert.equal(tableExists(db, "executions"), true);
    assert.equal(tableExists(db, "nope"), false);
    // No-op: column exists, table exists — nothing throws, nothing changes.
    ensureColumn(db, "executions", "submitted_hash", "TEXT");
    ensureTable(db, "executions", `CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY);`);
    assert.deepEqual(tableColumns(db, "executions"), ["id", "submitted_hash"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("migration helpers: failure on a read-only database throws MigrationError naming table and column", () => {
  const dbPath = join(makeTmpDir(), "readonly.db");
  const setup = new DatabaseSync(dbPath);
  createLegacyExecutions(setup);
  setup.close();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.throws(
      () => ensureColumn(db, "executions", "submitted_hash", "TEXT"),
      (err: unknown) =>
        err instanceof MigrationError &&
        /table 'executions' column 'submitted_hash'/.test(err.message) &&
        /readonly database/.test(err.message)
    );
    assert.throws(
      () =>
        ensureTable(
          db,
          "daily_spending",
          `CREATE TABLE IF NOT EXISTS daily_spending (agent_id TEXT NOT NULL, asset TEXT NOT NULL, day TEXT NOT NULL, total REAL NOT NULL DEFAULT 0, PRIMARY KEY (agent_id, asset, day));`
        ),
      (err: unknown) =>
        err instanceof MigrationError &&
        /table 'daily_spending'/.test(err.message) &&
        /readonly database/.test(err.message)
    );
    // The migration did not happen: the column/table are still missing.
    assert.equal(tableHasColumn(db, "executions", "submitted_hash"), false);
    assert.equal(tableExists(db, "daily_spending"), false);
  } finally {
    db.close();
    cleanup();
  }
});

test("SQLiteExecutionStore: legacy database gains submitted_hash on startup", () => {
  const dbPath = join(makeTmpDir(), "legacy.db");
  const setup = new DatabaseSync(dbPath);
  createLegacyExecutions(setup);
  assert.equal(tableHasColumn(setup, "executions", "submitted_hash"), false);
  setup.close();

  try {
    const store = new SQLiteExecutionStore(dbPath);
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(tableHasColumn(check, "executions", "submitted_hash"), true);
    } finally {
      check.close();
    }
    // Already-migrated startup stays clean (idempotent).
    assert.doesNotThrow(() => new SQLiteExecutionStore(dbPath));
    void store;
  } finally {
    cleanup();
  }
});

test("SQLiteScheduleStore: legacy database gains last_started_at on startup", () => {
  const dbPath = join(makeTmpDir(), "legacy.db");
  const setup = new DatabaseSync(dbPath);
  createLegacySchedules(setup);
  assert.equal(tableHasColumn(setup, "schedules", "last_started_at"), false);
  setup.close();

  try {
    new SQLiteScheduleStore(dbPath);
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(tableHasColumn(check, "schedules", "last_started_at"), true);
    } finally {
      check.close();
    }
    assert.doesNotThrow(() => new SQLiteScheduleStore(dbPath));
  } finally {
    cleanup();
  }
});

test("SQLiteActivityStore: database without daily_spending gains the table on startup", () => {
  const dbPath = join(makeTmpDir(), "legacy.db");
  const setup = new DatabaseSync(dbPath);
  setup.exec(`
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      idempotency_key TEXT,
      intent_json TEXT NOT NULL,
      policy_decision_json TEXT NOT NULL,
      authorization_status TEXT,
      simulation_result_json TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  assert.equal(tableExists(setup, "daily_spending"), false);
  setup.close();

  try {
    new SQLiteActivityStore(dbPath);
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(tableExists(check, "daily_spending"), true);
    } finally {
      check.close();
    }
    assert.doesNotThrow(() => new SQLiteActivityStore(dbPath));
  } finally {
    cleanup();
  }
});

test("SQLiteExecutionStore: migration blocked by a held lock refuses startup, and recovers after the lock clears", async () => {
  const dbPath = join(makeTmpDir(), "locked.db");
  // First open puts the file in WAL mode; the shared connection's
  // `PRAGMA journal_mode = WAL` only succeeds under a lock when the file
  // is already WAL.
  // The _meta table is created too: a real legacy database always has it
  // (getSharedConnection creates it on first open).
  const setup = new DatabaseSync(dbPath);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);`);
  setup.exec(`INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '5');`);
  createLegacyExecutions(setup);
  setup.close();

  const locker = new DatabaseSync(dbPath);
  locker.exec("BEGIN IMMEDIATE");
  locker.exec("CREATE TABLE IF NOT EXISTS _lock (x)");
  try {
    // NOTE: the write that blocks first is getSharedConnection's own
    // `INSERT OR IGNORE INTO _meta` (pre-existing setup, before initSchema),
    // so the constructor throws the raw SQLite "database is locked" here —
    // startup still refuses with FATAL (see main() in server.ts), just
    // without the table/column naming that MigrationError adds once the
    // failure lands inside a migration (covered by the read-only tests
    // above). The column is not added: no half-migrated database.
    assert.throws(
      () => new SQLiteExecutionStore(dbPath),
      (err: unknown) => err instanceof Error && /database is locked/.test(err.message)
    );
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(tableHasColumn(check, "executions", "submitted_hash"), false);
    } finally {
      check.close();
    }
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
  }

  // After the lock clears, startup succeeds and the migration runs.
  try {
    new SQLiteExecutionStore(dbPath);
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(tableHasColumn(check, "executions", "submitted_hash"), true);
    } finally {
      check.close();
    }
  } finally {
    cleanup();
  }
});
