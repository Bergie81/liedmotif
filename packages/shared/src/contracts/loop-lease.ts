// The repeat-one loop lease contract. The loop
// hold is a persisted LEASE, not a boolean ping: playback reports are
// fire-and-forget, so a TTL'd flag could not survive failed reports, reordered
// true/false messages, multiple tabs, or lock-screen timer throttling.
//
// Protocol rules (design decisions, "Repeat-one"). Each CLIENT owns its own
// lease on the session; the session is held while ANY client's lease is live:
// - `epoch` is monotonic PER CLIENT (e.g. a millisecond timestamp); the server
//   compares it only against the same client's own lease, so a same-client
//   acquire/renew/release with an epoch BELOW the stored one is stale and not
//   applied (reordering-safe).
// - `acquire` creates or refreshes the caller's own lease; it never touches
//   another client's — a second tab's hold is independent by construction.
// - `renew` extends only the caller's own live lease — it never creates one.
// - `release` releases only the caller's own lease: another tab's release
//   cannot cancel a hold it doesn't own.
// - Expiry (lock-screen throttling, network loss, crash) lapses a hold; the
//   buffer sweep resumes prefill once no live lease remains.
//
// Standalone contract (like `getTrack`), validated by `/api/sessions/loop-lease`.

import { z } from 'zod';
import { apiResponse, clientIdSchema, isoDatetimeSchema, uuidSchema } from './common';

/**
 * How long an acknowledged hold lives without renewal. Renewal piggybacks on the
 * ~5s playback-report cadence with ample margin; a throttled lock-screen
 * tab that stops renewing lapses within this window and prefill resumes.
 */
export const LOOP_LEASE_TTL_SECONDS = 60;

export const LOOP_LEASE_ACTIONS = ['acquire', 'renew', 'release'] as const;
export type LoopLeaseAction = (typeof LOOP_LEASE_ACTIONS)[number];

export const loopLeaseRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  clientId: clientIdSchema,
  /** Monotonic per client; a ms timestamp survives restarts (a counter would not). */
  epoch: z.number().int().nonnegative(),
  action: z.enum(LOOP_LEASE_ACTIONS),
});
export type LoopLeaseRequest = z.infer<typeof loopLeaseRequestSchema>;

/**
 * The ACKNOWLEDGED applied state: `applied` says whether this operation changed
 * the caller's lease; `held` is the session-level truth (any live lease, any
 * client) the UI and the buffer sweep both reflect; `lease` is the caller's OWN
 * lease row — a stale/rejected op still learns its real stored state.
 */
export const loopLeaseResponseSchema = apiResponse(
  z.strictObject({
    applied: z.boolean(),
    /** True while ANY client holds an unexpired, unreleased lease on the session. */
    held: z.boolean(),
    /** The caller's own lease (null when this client never held one). */
    lease: z
      .strictObject({
        epoch: z.number().int().nonnegative(),
        expiresAt: isoDatetimeSchema,
        released: z.boolean(),
      })
      .nullable(),
  }),
);
export type LoopLeaseResponse = z.infer<typeof loopLeaseResponseSchema>;
