// The start→player handoff. The start request is slow (the text LLM expands
// the vibe inside it), so the Start click must NOT wait on it: Home fires the
// request, stashes it here, and navigates to /player immediately —
// the player page narrates the connecting state and renders the outcome
// (headroom refusal or error). A module slot, not React state (same pattern
// as `autoplay-arm`): the gesture fires on Home, the narration on /player,
// and no common ancestor should re-render over a plumbing concern.
//
// The slot holds the Start until its request settles: every Start buys music,
// so a second tap — from a fresh Home visit while "Setting the vibe…" — must
// never fire a second start. The engage on success happens here, once,
// whichever page is mounted by then; a hard reload empties the slot, so a
// rediscovered session never auto-plays unprompted. Cancelling guarantees the
// Start never takes over the player, even when the server answered before the
// abort reached it. Sparing the purchase is best-effort: POST /api/sessions
// creates nothing when the abort lands while the vibe is still being set, but
// a later abort (or a fast Surprise Me start) still leaves the new Session
// Active server-side.

import type { SessionSummary } from '@liedmotif/shared';
import type { startSession } from '@/lib/api-client';

/** An in-flight session start crossing the Home→/player navigation. */
export interface PendingStart {
  /** The Start-click instant (ISO) — anchors the connecting progress bar. */
  startedAt: string;
  result: ReturnType<typeof startSession>;
  /** Aborted once the Start is cancelled. */
  signal: AbortSignal;
}

let pending: { start: PendingStart; controller: AbortController } | null = null;

/** A refused Start no player page has narrated yet: a fast refusal (the
 * headroom check runs before the text LLM) can settle before /player mounts. */
let unshownRefusal: Awaited<PendingStart['result']> | null = null;

/** Begin one Start. Refused (and `create` never called) while another Start
 * is in flight. `onStarted` runs once with the new session unless the Start
 * was cancelled first. */
export function beginPendingStart(
  create: (signal: AbortSignal) => PendingStart['result'],
  onStarted: (session: SessionSummary) => void,
): boolean {
  if (pending) return false;
  unshownRefusal = null;
  const controller = new AbortController();
  const entry = {
    controller,
    start: {
      startedAt: new Date().toISOString(),
      result: create(controller.signal),
      signal: controller.signal,
    },
  };
  pending = entry;
  void entry.start.result.then((result) => {
    if (pending !== entry) return;
    pending = null;
    if (result.ok) onStarted(result.data.session);
    else unshownRefusal = result;
  });
  return true;
}

/** The settled refusal of the last Start, once: the player page that shows it
 * takes it, so it never shows twice. */
export function takeUnshownStartRefusal(): Awaited<PendingStart['result']> | null {
  const refusal = unshownRefusal;
  unshownRefusal = null;
  return refusal;
}

/** The Start in flight, or null. */
export function currentPendingStart(): PendingStart | null {
  return pending?.start ?? null;
}

/** Cancel the Start in flight, if any. */
export function cancelPendingStart(): void {
  pending?.controller.abort();
  pending = null;
}
