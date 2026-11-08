// Shared sunoapi.org wire-format knowledge for BOTH Suno adapters (the music
// provider and the cover-art image fallback): the response envelope and the
// task-id payload shape, plus the connection defaults. Each adapter keeps its
// own fetch/error semantics — only the vendor's data shapes live here, so the
// two can never drift on what a Suno response looks like.

export const SUNO_DEFAULT_BASE_URL = 'https://api.sunoapi.org';

/**
 * The API REQUIRES a `callBackUrl` even though both adapters poll their
 * record-info endpoints; neither relies on the callback firing, so it defaults
 * to a harmless placeholder.
 */
export const SUNO_DEFAULT_CALLBACK_URL = 'https://example.com/no-callback';

export interface SunoEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

/** Bearer-auth headers — the ONLY place the API key ever rides. */
export function sunoAuthHeaders(
  apiKey: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...extra };
}

/** A non-empty string, or undefined — the "treat '' / missing as absent" rule, named. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Outcome of a single JSON request, normalized so each caller maps the failure
 * to its OWN sanitized result. The raw error is never surfaced: a thrown fetch
 * is `transport`, a non-2xx response is `http`, an unparseable body is `parse`.
 */
export type SunoFetchJsonResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'transport' | 'parse' }
  | { ok: false; reason: 'http'; status: number };

/**
 * 4xx statuses that do NOT prove the request was refused unprocessed: behind
 * each one the provider may already hold (and have charged for) a task.
 */
const AMBIGUOUS_CLIENT_ERROR_CODES = new Set([
  408, // Request Timeout — the server read the request and may have started it
  409, // Conflict — a duplicate submit implies a task that already exists
  425, // Too Early — a replayed request may already be processing
]);

/**
 * Whether a code proves the provider refused the call without charging for it:
 * a complete, well-formed client-error code outside the ambiguous set above.
 * One rule governs both channels a rejection can arrive on, because the API
 * mirrors HTTP's numbers in its own envelope (400 invalid, 429 out of credits,
 * 455 maintenance).
 */
function isDefinitiveRejectionCode(code: number | undefined): boolean {
  return code != null && code >= 400 && code < 500 && !AMBIGUOUS_CLIENT_ERROR_CODES.has(code);
}

/**
 * Whether a call PROVES the provider created nothing and so charged nothing.
 * Only the channel that actually carried the rejection is read — the HTTP
 * status when the response itself was the failure, otherwise the envelope's own
 * `code`, since the API also refuses under HTTP 200 — so an ambiguous failure
 * can never be mistaken for a definitive one. An absent code, a server error, a
 * timeout and a transport failure are all indefinite: the money path keeps
 * counting them as spend.
 *
 * Ask only about a call that FAILED. A successful call carries a task the
 * provider did create — and a task id alongside a non-200 envelope code is how
 * a duplicate submit answers — so "nothing was created" is not this predicate's
 * to answer there.
 */
export function isDefinitiveRejection(result: SunoFetchJsonResult): boolean {
  return isDefinitiveRejectionCode(sunoFailureCode(result));
}

/**
 * The code on the channel that carried a failed call's rejection (see
 * `isDefinitiveRejection`), or undefined when no code arrived.
 */
export function sunoFailureCode(result: SunoFetchJsonResult): number | undefined {
  if (!result.ok) return result.reason === 'http' ? result.status : undefined;
  return sunoEnvelopeCode(result.payload);
}

/**
 * Issue one time-bounded request and return its parsed JSON, or a sanitized
 * failure reason. Every Suno call is bounded: a provider that accepts the
 * connection but trickles/never finishes the response aborts to `transport`
 * instead of pinning the caller (e.g. a worker slot) inside one fetch.
 */
export async function sunoFetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<SunoFetchJsonResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch {
    return { ok: false, reason: 'transport' };
  }
  if (!response.ok) return { ok: false, reason: 'http', status: response.status };
  try {
    return { ok: true, payload: await response.json() };
  } catch {
    // A timeout mid-body is a transport failure, not a malformed payload.
    return { ok: false, reason: signal.aborted ? 'transport' : 'parse' };
  }
}

export function isSunoEnvelope(value: unknown): value is SunoEnvelope {
  return typeof value === 'object' && value !== null;
}

/**
 * Pull the envelope `code` from a response payload, or undefined when it is
 * absent or not a number.
 */
function sunoEnvelopeCode(payload: unknown): number | undefined {
  if (!isSunoEnvelope(payload)) return undefined;
  return typeof payload.code === 'number' ? payload.code : undefined;
}

/**
 * Pull `data.taskId` from a response payload, or undefined if absent/malformed.
 * Deliberately ignores the envelope `code`: a duplicate cover submit carries
 * the EXISTING task id under a non-200 code, and callers that require success
 * check the code themselves.
 */
export function sunoEnvelopeTaskId(payload: unknown): string | undefined {
  if (!isSunoEnvelope(payload)) return undefined;
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const taskId = (data as { taskId?: unknown }).taskId;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined;
}
