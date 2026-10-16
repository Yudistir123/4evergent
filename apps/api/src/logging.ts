import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// --- Request ID propagation ---
//
// The correlation ID lives in its own AsyncLocalStorage so downstream
// handlers can read it with getRequestId() without a circular dependency
// on the shared RequestContext type.

const requestIdStorage = new AsyncLocalStorage<string>();

/** Correlation ID for the in-flight request, or undefined outside a request. */
export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/** Runs `fn` with `requestId` as the ambient correlation ID. */
export function runRequestIdContext<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

/** Echoes a caller-supplied ID, otherwise generates a UUID v4. */
export function generateRequestId(supplied: string | undefined): string {
  if (supplied && supplied.length > 0) return supplied;
  return randomUUID();
}

// --- Structured logging ---
//
// One JSON object per line on process.stdout. No dependencies — the repo
// style avoids adding packages (packages/shared has zero deps).

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const priority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolvedLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (raw && LOG_LEVELS.includes(raw as LogLevel)) return raw as LogLevel;
  return "info";
}

const currentPriority = priority[resolvedLevel()];

export interface LogFields {
  [key: string]: unknown;
}

/** Emits a single JSON log line to stdout. Suppressed below `LOG_LEVEL`. */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (priority[level] < currentPriority) return;
  const entry: Record<string, unknown> = {
    level,
    msg: message,
    ts: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = value;
  }
  console.log(JSON.stringify(entry));
}

// --- Redaction helpers ---
//
// Request log lines carry no headers or body, so nothing sensitive can leak.
// These helpers exist so future log fields that DO include headers/bodies
// can be sanitized in one place.

const SENSITIVE_HEADERS = new Set(["authorization", "idempotency-key"]);

/** Returns a copy of `headers` with sensitive header values replaced. */
export function redactHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return result;
}

/** Returns a copy of a JSON body with any `stellarAddress` value redacted. */
export function redactBody(body: string | undefined): string | undefined {
  if (!body) return body;
  try {
    const obj = JSON.parse(body) as unknown;
    redactStellarAddress(obj);
    return JSON.stringify(obj);
  } catch {
    return /"stellarAddress"\s*:/i.test(body) ? "[REDACTED]" : body;
  }
}

function redactStellarAddress(obj: unknown): void {
  if (typeof obj !== "object" || obj === null) return;
  if (Array.isArray(obj)) {
    for (const item of obj) redactStellarAddress(item);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (key.toLowerCase() === "stellaraddress") {
      rec[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      redactStellarAddress(value);
    }
  }
}
