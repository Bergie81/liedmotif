// Opaque keyset-paging cursor shared by the cursor-paged list queries (the
// track-centric Library and the session-centric My Sessions). One reviewed
// codec, so EVERY paged route gets the same guarantee: nothing Postgres would
// reject can ever reach the raw `::timestamptz` / `::uuid` keyset casts.

export interface KeysetCursor {
  /** Canonical UTC ISO-8601 sort timestamp (`Date#toISOString()` output). */
  t: string;
  /** Row UUID tie-breaker. */
  id: string;
}

export type ParseKeysetCursorResult = { ok: true; cursor: KeysetCursor } | { ok: false };

const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A canonical UTC ISO-8601 timestamp of a REAL calendar moment — exactly what
 * `Date#toISOString()` (the cursor encoder's source) emits. The round-trip identity
 * check is as strict as Postgres `::timestamptz`: it rejects values `Date.parse`
 * silently NORMALIZES rather than failing (e.g. `2026-02-30` → `2026-03-02`, `2026-04-31`
 * → `2026-05-01`), out-of-range fields (hour 25, month 13), and non-canonical shapes
 * (`'2026'`) — so nothing Postgres would reject can ever reach the keyset cast.
 * `new Date(bad)` yields an Invalid Date (NaN getTime); the `&&` short-circuits before
 * `toISOString()` so an out-of-range string never throws. @liedmotif/db stays zod-free,
 * so this is a plain check rather than `isoDatetimeSchema`. Only four-digit years
 * from 0001 pass: `toISOString()` also round-trips year 0000 and the signed
 * extended years (`+010000-…`, `-000001-…`), which Postgres refuses.
 */
function isCanonicalUtcIsoTimestamp(t: string): boolean {
  const d = new Date(t);
  return (
    /^\d{4}-/.test(t) &&
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() >= 1 &&
    d.toISOString() === t
  );
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode AND validate an opaque keyset cursor. Returns `{ ok: false }` for ANY
 * tampered input — not base64, not JSON, not an object, missing/extra fields, a `t`
 * that is not a timestamptz-safe ISO datetime, or an `id` that is not a UUID — so the
 * route can surface it as the consistent `validation_error` envelope instead of
 * letting a garbage value reach a raw Postgres `::timestamptz`/`::uuid` cast (a 500).
 * The keyset paths (`decodeKeysetCursor`) reuse this, so a bad cursor can never
 * reach SQL.
 */
export function parseKeysetCursor(raw: string): ParseKeysetCursorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false };
  // Exactly `{ t, id }` — reject missing OR extra fields.
  if (Object.keys(parsed).length !== 2) return { ok: false };
  const { t, id } = parsed as Record<string, unknown>;
  if (typeof t !== 'string' || !isCanonicalUtcIsoTimestamp(t)) return { ok: false };
  if (typeof id !== 'string' || !CURSOR_UUID_RE.test(id)) return { ok: false };
  return { ok: true, cursor: { t, id } };
}

/** Defense-in-depth: a validated cursor or null (first page) — never reaches SQL invalid. */
export function decodeKeysetCursor(raw: string): KeysetCursor | null {
  const result = parseKeysetCursor(raw);
  return result.ok ? result.cursor : null;
}
