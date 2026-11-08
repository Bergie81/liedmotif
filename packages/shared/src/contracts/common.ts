// Shared building blocks for the API contracts: the id/datetime
// primitives, the ONE consistent user-visible error shape, the success/error
// response envelope, and the auth + retry metadata types every endpoint declares.
//
// Every endpoint response is a discriminated union on `ok`: a success payload
// (`{ ok: true, data }`) or the single `errorResponseSchema` (`{ ok: false,
// error }`). That guarantees a uniform error shape across all 15 endpoints. All
// request/response objects are STRICT (`z.strictObject`) so unknown/extra keys are
// rejected — clients and the server can never silently drift on field names.

import { z } from 'zod';

// --- Primitives --------------------------------------------------------------

/** App entity ids are random UUIDs (`packages/db` `pk()` = `uuid().defaultRandom()`). */
export const uuidSchema = z.uuid();

/**
 * A playback controller id minted by the client (`activePlaybackClientId` is
 * `text`, not a UUID — it identifies a device/tab, not a DB row). Bounded so it
 * can't be used to smuggle large payloads.
 */
export const clientIdSchema = z.string().min(1).max(200);

/** An ISO-8601 timestamp with a timezone offset (app columns are `timestamptz`). */
export const isoDatetimeSchema = z.iso.datetime({ offset: true });

// --- Error shape + response envelope ----------------------------------------

/**
 * The closed set of user-visible error codes. Deliberately small and
 * vendor-neutral: provider/raw errors are never surfaced (logs/errors
 * must not leak keys, URLs, or raw provider errors).
 */
export const API_ERROR_CODES = [
  'validation_error',
  'unauthorized',
  // Refused on the request's own terms, where signing in would change nothing:
  // a mutation carrying a cross-site `Origin`.
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'limit_reached',
  // Creation-time headroom gate: Start Session / More Like This are
  // refused below the minimum remaining headroom — NO session is created — and the
  // client is prompted to Resume (My Sessions) or play the Library. Distinct from
  // `limit_reached`: a running session never raises this (it degrades to Session
  // Repeat instead), and Resume is never gated by it.
  'session_headroom_blocked',
  // Change Vibe at the Session duration target: a new revision could
  // never fill there, so the change is refused before any text-LLM call.
  'session_duration_reached',
  'provider_error',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The single user-visible error shape shared by every endpoint. */
export const errorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    /** A safe, user-facing message — never a raw provider error or secret. */
    message: z.string(),
    /** Whether the client may retry the same request as-is. */
    retryable: z.boolean(),
    /** Optional structured detail (e.g. per-field validation issues). */
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * Wrap a success-data schema into the standard response envelope: a discriminated
 * union (on `ok`) of `{ ok: true, data }` and the shared error shape.
 */
export function apiResponse<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: dataSchema }),
    errorResponseSchema,
  ]);
}

/** Build a well-formed error response (ergonomic constructor for servers/tests). */
export function makeApiError(
  code: ApiErrorCode,
  message: string,
  retryable = false,
  details?: unknown,
): ApiErrorResponse {
  return {
    ok: false,
    error:
      details === undefined ? { code, message, retryable } : { code, message, retryable, details },
  };
}

// --- Endpoint metadata -------------------------------------------------------

/**
 * Auth requirement. EVERY contract in the registry declares `admin` and none
 * declares `public`; the guard each route calls (some admit Members too) is the
 * authorization boundary.
 */
export type AuthRequirement = 'admin' | 'public';

/** Documented client retry behavior for an endpoint. */
export interface RetryPolicy {
  /** May the client retry the same request as-is? */
  retryable: boolean;
  /** Is the operation idempotent (a retry can't double-apply an effect)? */
  idempotent: boolean;
  /** Human note explaining the policy (e.g. paid-submit / append-only nuances). */
  note: string;
}

/** A single endpoint contract: its route, auth, request/response schemas, retry policy. */
export interface EndpointContract {
  method: 'GET' | 'POST';
  /** The intended app route, recorded here for reference. */
  path: string;
  auth: AuthRequirement;
  request: z.ZodType;
  response: z.ZodType;
  retry: RetryPolicy;
  description: string;
}
