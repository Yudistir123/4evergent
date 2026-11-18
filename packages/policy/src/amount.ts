/**
 * Strict Stellar amount parsing (issue #264).
 *
 * Canonical Stellar decimal form only: one or more digits, optionally
 * followed by "." and 1–7 fractional digits. No sign, no exponent,
 * no whitespace, no trailing junk.
 *
 * `parseFloat` silently accepts "10abc" (→ 10) and "1e2" (→ 100), so the
 * policy gate and the ledger could disagree about an amount. Every amount
 * check in ingestion and policy goes through this single parser — there
 * must be no second implementation.
 *
 * The parser validates format only. Positivity / zero handling stays with
 * the caller (the engine rejects zero/negative amounts; config validation
 * rejects non-positive limits where the schema requires them).
 */
const STRICT_AMOUNT_RE = /^\d+(?:\.\d{1,7})?$/;

/**
 * Parse a Stellar amount strictly. Returns the numeric value, or `null`
 * when the value is not a canonical Stellar decimal string/number.
 *
 * Accepts `string | number` because policy config values may be either;
 * numbers are judged by their canonical string form, so `1e-7` (which is
 * `0.0000001` numerically but exponent form as a string) is rejected, just
 * like the string "1e-7".
 */
export function parseStrictAmount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return STRICT_AMOUNT_RE.test(String(value)) ? value : null;
  }
  if (typeof value !== "string") return null;
  if (!STRICT_AMOUNT_RE.test(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** True when `value` is a canonical Stellar decimal amount. */
export function isStrictAmount(value: unknown): boolean {
  return parseStrictAmount(value) !== null;
}
