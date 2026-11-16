// Request guards and contract-shaped responses for the API routes. The
// responses emit the shared `apiResponse` envelope — the discriminated
// `{ ok: true, data }` / `{ ok: false, error }` shape every contract declares — so
// the client decodes every route uniformly.
//
// ONE guard vocabulary: the auth gates (`requireOwnerId`, `requireAdminOwnerId`,
// `requireBytesOwnerId`) and the input gates (`parseJsonBody`,
// `readJsonObjectBody`, `validateInput`, `validateKeysetCursor`) each return
// either the value the route needs or the early `NextResponse` it should return.
// A `NextResponse` is never a valid parsed value, so callers discriminate with
// `instanceof NextResponse` — the same two opening lines in every handler,
// whatever it guards on. `readJsonBody` sits under the two body gates and hands
// back a reason instead, for the one route that renders its own refusals.

import { NextResponse } from 'next/server';
import { parseKeysetCursor } from '@liedmotif/db';
import { makeApiError, type ApiErrorCode } from '@liedmotif/shared';
import { getPublicUrl } from '@/lib/env';
import { badRequest, forbidden } from '@/lib/http';
import { getAdminSession, getAppSession } from '@/lib/session';

/** Default HTTP status per error code (a safe, vendor-neutral mapping). */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  limit_reached: 429,
  // Creation-time headroom gate refusal: treated as a soft 429 — the
  // user is prompted to Resume (My Sessions) or browse the Library, not to retry.
  session_headroom_blocked: 429,
  session_duration_reached: 409,
  assistant_unavailable: 503,
  assistant_access_off: 403,
  assistant_allowance_used_up: 429,
  provider_error: 502,
  internal_error: 500,
};

/** A successful contract response: `{ ok: true, data }`. */
export function apiOk<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data });
}

/** A contract error response: `{ ok: false, error: { code, message, retryable } }`. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  opts: {
    retryable?: boolean;
    status?: number;
    details?: unknown;
    headers?: Record<string, string>;
  } = {},
): NextResponse {
  const body = makeApiError(code, message, opts.retryable ?? false, opts.details);
  return NextResponse.json(body, {
    status: opts.status ?? STATUS_BY_CODE[code],
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
}

/**
 * The structural slice of a Zod schema these guards use — just `safeParse`. Typed
 * structurally so `apps/web` need not depend on `zod` directly; the real schemas
 * (from `@liedmotif/shared`) satisfy it.
 */
interface RequestSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

/** HTTP methods that only read. CSRF is about forged WRITES, so these pass. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** One wording for both response shapes the refusal is written in. */
const CROSS_ORIGIN_REFUSAL = 'Cross-origin request refused.';

/** A URL string as a `URL`, or null when it is not one. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * CSRF's second layer: whether a browser says this mutation came from another
 * site. Every cookie-authenticated route here has only Better Auth's
 * `SameSite=Lax` cookie between it and cross-site writes — one control, and one
 * that degrades QUIETLY: a plain-http `APP_PUBLIC_URL` drops `Secure` with a
 * boot warning, and any future subdomain-hosted content reopens classic CSRF
 * including the uploads.
 *
 * Two things pass. A SAFE method, because a forged read is not an attack — the
 * response carries no CORS header, so a foreign page cannot read it — and this
 * is what keeps the byte-serving GETs (audio, avatars, downloads) untouched.
 * And an ABSENT `Origin`, because browsers omit it on same-origin GETs and
 * non-browser clients (curl, the Docker healthcheck) never send one: the header
 * is evidence of cross-site intent, not of legitimacy.
 *
 * A present one must match `APP_PUBLIC_URL` exactly, comparing normalized
 * origins so a default port is not a mismatch. That is the same exact-match
 * rule Better Auth's own `trustedOrigins` applies: an instance reachable at a
 * second hostname must say so in `APP_PUBLIC_URL`. An opaque `Origin: null`
 * (sandboxed iframe, some redirect chains) parses to nothing and is refused,
 * which is the right answer for a write.
 *
 * `allowSelfHost` additionally accepts an `Origin` whose HOST is the one this
 * request was addressed to. It belongs to the first-run setup routes only:
 * before the wizard finishes, `APP_PUBLIC_URL` is still whatever the image
 * shipped (the localhost default) while the operator browses by LAN IP, so the
 * configured origin is not yet authority over the instance's own address. Hosts
 * are compared without the scheme because TLS terminates at the proxy — the
 * browser reports `https:` on a request that arrives as plain http. A forged
 * post still fails: an attacker page's `Origin` carries the attacker's host,
 * never the instance's.
 */
function isCrossOriginWrite(request: Request, opts: { allowSelfHost?: boolean } = {}): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const header = request.headers.get('origin');
  if (header === null) return false;
  const sent = parseUrl(header);
  if (sent === null) return true;
  if (sent.origin === parseUrl(getPublicUrl())?.origin) return false;
  if (!opts.allowSelfHost) return true;
  return sent.host !== new URL(request.url).host;
}

/** The cross-origin refusal as a contract-envelope 403, or null to proceed. */
export function refuseCrossOrigin(request: Request): NextResponse | null {
  return isCrossOriginWrite(request) ? apiError('forbidden', CROSS_ORIGIN_REFUSAL) : null;
}

/**
 * `refuseCrossOrigin` for the first-run setup route: self-host comparison, and
 * the plain `{ ok, error }` shape that route answers in — the wizard reads
 * `error` as a string, and the envelope's nested error would reach it as one.
 */
export function refuseSetupCrossOrigin(request: Request): NextResponse | null {
  return isCrossOriginWrite(request, { allowSelfHost: true })
    ? forbidden(CROSS_ORIGIN_REFUSAL)
    : null;
}

/**
 * Member-or-Admin auth gate for a content route: the signed-in ACTIVE user's id
 * (the owner id the route scopes every read and write to), or the `NextResponse`
 * to return — a 403 for a cross-site request, else the 401. Disabled users are
 * refused here too — role and disabled state are re-read from the database per
 * request, never trusted from the cookie.
 *
 * Boundary rule: content routes use this; instance-configuration routes
 * (settings/credentials, limits, voice, diagnostics, members) MUST use
 * `requireAdminOwnerId` instead — the guard choice at the
 * route is the whole authorization boundary, so a new settings route must pick
 * the admin gate deliberately, never inherit Member access by copying a
 * content route.
 */
export async function requireOwnerId(request: Request): Promise<string | NextResponse> {
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const session = await getAppSession();
  if (!session) return apiError('unauthorized', 'Sign-in required.');
  return session.user.id;
}

/**
 * Admin-only auth gate for instance-configuration routes: the admin's user id,
 * or the 403/401 `NextResponse`. See `requireOwnerId` for the boundary rule. The
 * refusal is deliberately the same shape for "not signed in" and "not the
 * admin" — a Member probing an admin route learns nothing.
 */
export async function requireAdminOwnerId(request: Request): Promise<string | NextResponse> {
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const session = await getAdminSession();
  if (!session) return apiError('unauthorized', 'Admin sign-in required.');
  return session.user.id;
}

/**
 * A contract-envelope 429 carrying `Retry-After` (seconds). The rate-limit
 * refusal for routes that speak the envelope — a handler must not answer one
 * caller in two different shapes.
 */
export function apiRateLimited(retryAfterMs: number): NextResponse {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return apiError('rate_limited', 'Too many requests. Please slow down.', {
    retryable: true,
    headers: { 'Retry-After': String(seconds) },
  });
}

/**
 * Member-or-Admin gate for a BYTE-serving route (audio, covers, avatars): the
 * owner id, or a bare 401. These endpoints have no client that decodes the JSON
 * envelope, so the refusal carries no body rather than a JSON error under an
 * image or audio content type.
 *
 * No Origin check, and none is needed: `refuseCrossOrigin` passes safe methods,
 * and byte serving is all GET.
 */
export async function requireBytesOwnerId(): Promise<string | NextResponse> {
  const session = await getAppSession();
  if (!session) return new NextResponse(null, { status: 401 });
  return session.user.id;
}

/**
 * The refusal for a body that fails its schema: a fixed string, or a resolver
 * over the flattened Zod issues for routes whose refusal should name the field
 * that failed (e.g. the password-policy message) instead of a generic line.
 */
type InvalidMessage = string | ((details: unknown) => string);

/**
 * A resolver for `InvalidMessage`: the first Zod issue on `field`, or the
 * fallback when the failure lies elsewhere.
 */
export function fieldErrorMessage(field: string, fallback: string): (details: unknown) => string {
  return (details) => {
    const errors = (details as { fieldErrors?: Record<string, unknown> } | null)?.fieldErrors?.[
      field
    ];
    return Array.isArray(errors) && typeof errors[0] === 'string' ? errors[0] : fallback;
  };
}

/**
 * Validate already-decoded input against a contract schema: the parsed value, or a
 * 400 carrying the flattened Zod issues under `details`. Use for query-param objects
 * the route assembles itself; `parseJsonBody` wraps it for request bodies.
 */
export function validateInput<T>(
  schema: RequestSchema<T>,
  data: unknown,
  invalidMessage: InvalidMessage,
): T | NextResponse {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.flatten();
    const message = typeof invalidMessage === 'function' ? invalidMessage(details) : invalidMessage;
    return apiError('validation_error', message, { details });
  }
  return parsed.data;
}

/**
 * Validate an opaque keyset-cursor query param at the route boundary: null for
 * a missing/empty value (first page), the cursor when its DECODED contents
 * (timestamp + uuid) are sound, or the 400 to return. Keeps a tampered cursor
 * inside the SAME `validation_error` envelope as any other bad query param —
 * never a raw DB 500 from the keyset SQL cast.
 */
export function validateKeysetCursor(
  cursor: string | null | undefined,
  invalidMessage: string,
): string | null | NextResponse {
  if (cursor == null || cursor === '') return null;
  if (!parseKeysetCursor(cursor).ok) return apiError('validation_error', invalidMessage);
  return cursor;
}

/**
 * Ceiling on a JSON request body. The largest one any surface sends is a
 * full-membership playlist order (500 uuids), so this is orders of magnitude
 * above real traffic — it exists to bound the heap, not to validate a payload.
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * What multipart framing (boundaries, part headers, the short text fields the
 * cover and recording forms carry) adds on top of the file bytes, so a legitimate
 * upload at its surface's cap is never refused for its envelope.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** The size the request declares for its body, or null when it declares none. */
function declaredBodyBytes(request: Request): number | null {
  const header = request.headers.get('content-length')?.trim();
  const declared = header ? Number(header) : NaN;
  return Number.isFinite(declared) ? declared : null;
}

/**
 * Declared-size gate for a MULTIPART upload: the 413 to return, or null to
 * proceed. `formData()` buffers the whole body into heap, so a per-file cap read
 * after the parse is far too late to bound memory — and unlike JSON there is no
 * streaming read to fall back on, which is why an UNDECLARED body is refused
 * outright: a browser always declares the length of a multipart body, so one
 * that does not is either hostile or streamed.
 *
 * A lying `Content-Length` is stopped by the proxy's `request_body max_size`,
 * which is why both layers exist.
 */
export function refuseOversizedBody(
  request: Request,
  opts: { maxBytes: number; tooLargeMessage: string },
): NextResponse | null {
  const declared = declaredBodyBytes(request);
  if (declared === null) {
    return apiError('validation_error', 'The upload must declare its size.', { status: 413 });
  }
  if (declared > opts.maxBytes) {
    return apiError('validation_error', opts.tooLargeMessage, { status: 413 });
  }
  return null;
}

/**
 * The body as text, or null once it passes `maxBytes` — counted as the chunks
 * arrive, so the read is abandoned mid-body and nothing beyond the ceiling is
 * ever held. `request.text()`/`request.json()` would buffer to completion first,
 * which is exactly what an undeclared (chunked) body would otherwise exploit.
 *
 * The decoder runs across the whole stream rather than per chunk: a multi-byte
 * character straddling a chunk boundary is ordinary, and decoding each half on
 * its own would replace it with U+FFFD.
 */
async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  const stream = request.body;
  // A null body is the absence of one, not an unread one: there are no bytes to
  // count, and the caller's `JSON.parse` refuses the empty text as invalid.
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A body that was read and decoded, or the reason it was not. */
type JsonBody = { ok: true; value: unknown } | { ok: false; tooLarge: boolean };

/**
 * THE way a route reads a JSON body: the decoded value under a hard byte
 * ceiling. Every JSON-taking route goes through it, so
 * the ceiling holds whether or not the request declares its size — the declared
 * length only buys the cheaper refusal, before a byte is read.
 *
 * A refusal comes back as a reason rather than a response because the API
 * answers in two shapes: the contract envelope most routes speak, whose `error`
 * is an object, and the flat `{ ok: false, error: '…' }` the settings and setup
 * screens read as a string. The wrappers below render one each.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<JsonBody> {
  const declared = declaredBodyBytes(request);
  if (declared !== null && declared > maxBytes) return { ok: false, tooLarge: true };
  try {
    const text = await readCappedText(request, maxBytes);
    if (text === null) return { ok: false, tooLarge: true };
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/**
 * Read and validate a JSON request body against a contract schema: the parsed value,
 * a 413 for a body over `MAX_JSON_BODY_BYTES`, a 400 for a non-JSON body, or a 400
 * carrying the flattened Zod issues for a body that fails the schema.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: RequestSchema<T>,
  invalidMessage: InvalidMessage,
): Promise<T | NextResponse> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.tooLarge
      ? apiError('validation_error', 'The request body is too large.', { status: 413 })
      : apiError('validation_error', 'Invalid request body.');
  }
  return validateInput(schema, body.value, invalidMessage);
}

/**
 * `parseJsonBody` for the settings and setup routes: the body as a plain object,
 * or the refusal in the flat `{ ok: false, error }` shape those screens read
 * `error` from as a string. They validate field by field rather than against a
 * contract schema, so what they need from the boundary is the byte ceiling and
 * the guarantee that they are indexing an object — JSON yields nulls, arrays and
 * primitives just as happily.
 */
export async function readJsonObjectBody(
  request: Request,
): Promise<Record<string, unknown> | NextResponse> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.tooLarge
      ? NextResponse.json({ ok: false, error: 'The request body is too large.' }, { status: 413 })
      : badRequest('Invalid request body.');
  }
  const value = body.value;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : badRequest('Invalid request body.');
}
