// The bound on how many upload requests the web process serves at once.
//
// Every upload surface caps ONE request (declared length, file size, decoded
// format); nothing caps the sum. `formData()` materializes the whole multipart
// body into heap, and the decode slots gate only the sharp pass that comes
// after — so enough simultaneous, entirely legal uploads exhaust the container
// and restart it, taking playback and every other user with it. Compose's own
// memory limit protects the HOST, not availability.
//
// Two properties make this an actual bound rather than a rate shaper. The slot
// is taken BEFORE the body is read, so intake happens inside it. And it is held
// for the WHOLE handler, because the buffered body, its decoded rendition and
// the bytes being written all stay resident until the response is built —
// releasing at the end of intake would bound arrivals while leaving what is
// simultaneously in memory unbounded. It also means nothing reaches the
// downstream decode slots without holding an admission slot, so that queue can
// never grow past this ceiling either.
//
// Saturation refuses rather than queueing without limit: a waiter that has
// already read its body is not backpressure. Waiting callers hold nothing but
// their headers, which is why waiting at all is cheap.

import { Semaphore, SemaphoreBusyError } from '@liedmotif/shared';
import { apiRateLimited } from '@/lib/http/api-response';

/**
 * Upload requests served at once. The fattest surface is a 32 MiB voice
 * recording, so this bounds the worst-case heap the upload path can hold —
 * small next to the container, and well above any real simultaneous-upload
 * count on a personal instance.
 */
const UPLOAD_SLOTS = 6;

/** Callers allowed to wait for a slot before the answer becomes "not now". */
const UPLOAD_WAITERS = 12;

/**
 * How long a caller waits. Long enough to absorb one slot's turnaround (a fat
 * body over a slow link, then a decode), short enough that a saturated process
 * answers rather than holding connections open.
 */
const UPLOAD_WAIT_MS = 15_000;

/**
 * Uploads one owner may have in the gate — running or waiting. The global bound
 * keeps the process alive; this one keeps a single buggy client (or a single
 * compromised Member) from being the reason everyone else waits. Every upload
 * surface is one-file-at-a-time, so no real client reaches it.
 */
const UPLOAD_PER_OWNER = 3;

/** What a refused caller is told to wait, in the envelope's `Retry-After`. */
const RETRY_AFTER_MS = 5_000;

const uploadSlots = new Semaphore(UPLOAD_SLOTS, {
  maxWaiting: UPLOAD_WAITERS,
  waitTimeoutMs: UPLOAD_WAIT_MS,
});

/** In-flight uploads per owner; an owner drops out of the map at zero. */
const inFlightByOwner = new Map<string, number>();

function enter(ownerUserId: string): boolean {
  const inFlight = inFlightByOwner.get(ownerUserId) ?? 0;
  if (inFlight >= UPLOAD_PER_OWNER) return false;
  inFlightByOwner.set(ownerUserId, inFlight + 1);
  return true;
}

function leave(ownerUserId: string): void {
  const remaining = (inFlightByOwner.get(ownerUserId) ?? 1) - 1;
  if (remaining > 0) inFlightByOwner.set(ownerUserId, remaining);
  else inFlightByOwner.delete(ownerUserId);
}

/**
 * Serve an upload request inside one of the process's admission slots: whatever
 * `handle` answers, or the 429 to send when there is no room for it. Wrap the
 * handler from the auth guard onwards, so the body read is inside the slot.
 *
 * Saturation answers in the contract's retryable rate-limit shape — the caller
 * is not at fault, but "try again shortly" is exactly what the envelope's 429
 * already means to every client that decodes it.
 */
export async function withUploadAdmission(
  ownerUserId: string,
  handle: () => Promise<Response>,
): Promise<Response> {
  if (!enter(ownerUserId)) return apiRateLimited(RETRY_AFTER_MS);
  try {
    return await uploadSlots.run(handle);
  } catch (err) {
    if (err instanceof SemaphoreBusyError) return apiRateLimited(RETRY_AFTER_MS);
    throw err;
  } finally {
    leave(ownerUserId);
  }
}
