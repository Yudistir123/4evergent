import type { DatabaseSync } from "node:sqlite";

/**
 * Schema migration helpers (issue #401).
 *
 * Columns/tables added after a table's first release used to be migrated by
 * a bare `try { ... } catch {}` in `initSchema()`, which cannot tell
 * "already exists" (the expected case) from any other failure — a locked
 * database, a full disk, an I/O error, a corrupt page. The constructor then
 * returned normally and the server started healthy on a half-migrated
 * database, surfacing only at the first write as a confusing runtime error.
 *
 * Every helper here follows the same rule: the "already migrated" case is
 * detected explicitly (existence check first, duplicate/already-exists
 * error as a race safety net) and any other failure throws MigrationError,
 * which propagates out of the store constructor so server startup aborts
 * with a FATAL message naming the table, the column, and the underlying
 * SQLite error (see `main()` in apps/api/src/server.ts).
 *
 * Table/column names passed here are hardcoded internal literals at the
 * call sites; they are interpolated into PRAGMA/ALTER statements, never
 * taken from user input.
 */
export class MigrationError extends Error {
  readonly table: string;
  readonly column: string | null;

  constructor(table: string, column: string | null, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `database migration failed for table '${table}'` +
        (column ? ` column '${column}'` : "") +
        `: ${detail}`
    );
    this.name = "MigrationError";
    this.table = table;
    this.column = column;
    this.cause = cause;
  }
}

/** SQLite reports a repeated ADD COLUMN as "duplicate column name: <col>". */
function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

/** SQLite reports a repeated CREATE as "<object> already exists". */
function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && /already exists/i.test(err.message);
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

export function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

/**
 * Add `column` to `table` when it is missing. No-op when the column already
 * exists (including a duplicate-column error if another process migrated
 * concurrently). Any other failure throws MigrationError.
 */
export function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string
): void {
  let exists: boolean;
  try {
    exists = tableHasColumn(db, table, column);
  } catch (err) {
    throw new MigrationError(table, column, err);
  }
  if (exists) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (isDuplicateColumnError(err)) return;
    throw new MigrationError(table, column, err);
  }
}

/**
 * Run a `CREATE TABLE IF NOT EXISTS ...` migration (plus its indexes).
 * `IF NOT EXISTS` never throws "already exists", so any error is real and
 * throws MigrationError naming the table.
 */
export function ensureTable(db: DatabaseSync, table: string, createSql: string): void {
  try {
    db.exec(createSql);
  } catch (err) {
    if (isAlreadyExistsError(err)) return;
    throw new MigrationError(table, null, err);
  }
}
