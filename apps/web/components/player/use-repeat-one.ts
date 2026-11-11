'use client';

// Repeat-one coordination, split from the
// controller hook like the feedback actions (`use-track-actions.ts`): this
// module owns the loop PIN state machine (`loopControlTransition`), the
// acknowledged generation-hold lease (which Loop Track also takes before its
// pin can arm, and which every exit releases), the queue-snapshot invalidations
// (Change Vibe, stopped session, vanished pin), and the seam-length math.
// The controller supplies its playback surface through `depsRef` — assigned
// every render AFTER its own callbacks exist, read only at event time — and
// drives events from its commit/navigation/lifecycle paths.

import { useCallback, useRef, type RefObject } from 'react';
import {
  type ActivitySessionStatus,
  IDLE_LOOP_CONTROL,
  type LoopControlEvent,
  type LoopControlState,
  loopControlTransition,
  loopSeam,
  loopSeamViable,
  loopToggledOn,
} from '@liedmotif/shared';
import type { PlayableTrack, QueueTarget } from './playable-track';
import { useLoopLease, type LoopLeaseClient } from './use-loop-lease';

/** What a queue poll says about the live Session, for whatever a loop must end on. */
export interface LoopQueueSnapshot {
  /** A MOVE of the style revision is a Change Vibe, in any tab. */
  revisionMoved: boolean;
  sessionStatus: ActivitySessionStatus;
  queueItemIds: ReadonlySet<string>;
}

/** The controller surface repeat-one reads at event time (never in render). */
export interface RepeatOneDeps {
  queue(): PlayableTrack[];
  /** The active deck's truthful duration (buffer clock or element). */
  activeDurationSeconds(): number | null;
  /** The owner's crossfade setting (the seam shortens it to its overlap). */
  crossfadeSetting(): number;
  /** Re-sync the prepared-deck target (cancels an obsolete preparation). */
  syncPreparedTarget(): void;
  /** Render-state sink for whether the mode's seamless pin is active. */
  patch(next: { loopActive: boolean }): void;
  /** The acquire ack did not confirm the generation hold — tell the user. */
  onHoldFailed(): void;
}

/**
 * Every function on this surface is REFERENTIALLY STABLE across renders —
 * consumers destructure them straight into `useCallback`/`useEffect` deps.
 * Only `held` changes (React state); nothing that participates in the
 * controller's deck-lifecycle effect may depend on it, or an acquire ack
 * would re-run that effect and dispose the live audio engine.
 */
export interface RepeatOneApi {
  /** The server-ACKNOWLEDGED generation hold (any live lease on the session). */
  held: boolean;
  /** Whether any repeat-one pin exists. */
  pinned(): boolean;
  /** Run one loop-control event (commit/exit/seam-cancelled) through the table. */
  apply(event: LoopControlEvent): void;
  /** Report-cadence tick: renew the hold (self-heals a lapsed lease). */
  renew(): void;
  /** The generation hold itself, which Loop Track shares with other holders. */
  holdLease: LoopLeaseClient['hold'];
  /** The pin as a SEAM target: null when unpinned, gone from the queue, or too
   *  short for the minimum quantized fade (then nothing prepares and the
   *  natural-end restart takes over). */
  seamTarget(): QueueTarget | null;
  /** The pin as a natural-end restart target: null while not active. */
  restartTarget(): QueueTarget | null;
  /** The crossfade the next edge honors: the setting, shortened to the seam's
   *  overlap (≤ half the track) while a pin targets the audible track. */
  effectiveCrossfadeSeconds(): number;
  /** Queue-snapshot invalidations: Change Vibe (revision move), stopped
   *  session, and a pinned item that vanished from the projection. */
  onQueueSnapshot(snapshot: LoopQueueSnapshot): void;
}

export function useRepeatOne(
  sessionId: string | null,
  clientId: string,
  depsRef: RefObject<RepeatOneDeps | null>,
): RepeatOneApi {
  const stateRef = useRef<LoopControlState>(IDLE_LOOP_CONTROL);
  const { held, hold, renew } = useLoopLease(sessionId, clientId, () =>
    depsRef.current?.onHoldFailed(),
  );

  const apply = useCallback(
    (event: LoopControlEvent) => {
      const next = loopControlTransition(stateRef.current, event);
      stateRef.current = next.state;
      if (next.lease) hold('loop-track', next.lease === 'acquire');
      // Loop Track holds generation before its pin arms; an exit ends that too.
      else if (event.type === 'exit') hold('loop-track', false);
      if (next.syncTarget) depsRef.current?.syncPreparedTarget();
      depsRef.current?.patch({ loopActive: loopToggledOn(next.state) });
    },
    [depsRef, hold],
  );

  /** The pin resolved against the live queue projection (null = no pin, or its
   * track left the queue — `onQueueSnapshot` then exits the loop). */
  const pinInQueue = useCallback((): QueueTarget | null => {
    const pin = stateRef.current.pinned;
    const queue = depsRef.current?.queue() ?? [];
    if (!pin) return null;
    const idx = queue.findIndex((t) => t.queueItemId === pin.queueItemId);
    const track = idx >= 0 ? queue[idx] : undefined;
    return track ? { idx, track } : null;
  }, [depsRef]);

  const seamTarget = useCallback((): QueueTarget | null => {
    const loop = pinInQueue();
    if (!loop) return null;
    const duration = loop.track.durationSeconds ?? depsRef.current?.activeDurationSeconds() ?? null;
    return loopSeamViable(duration, loop.track.targetBpm) ? loop : null;
  }, [depsRef, pinInQueue]);

  const restartTarget = useCallback(
    (): QueueTarget | null => (loopToggledOn(stateRef.current) ? pinInQueue() : null),
    [pinInQueue],
  );

  const effectiveCrossfadeSeconds = useCallback((): number => {
    const deps = depsRef.current;
    const setting = deps?.crossfadeSetting() ?? 0;
    if (!deps || !stateRef.current.pinned) return setting;
    const duration = deps.activeDurationSeconds();
    return duration != null && duration > 0 ? loopSeam(duration, setting).overlapSeconds : setting;
  }, [depsRef]);

  const onQueueSnapshot = useCallback(
    (snapshot: LoopQueueSnapshot) => {
      // A vanished pinned item (server-side rejection/eviction) must not leave
      // a stale pin holding the lease until its TTL.
      const pin = stateRef.current.pinned;
      const pinVanished = pin != null && !snapshot.queueItemIds.has(pin.queueItemId);
      if (snapshot.revisionMoved || pinVanished || snapshot.sessionStatus !== 'active') {
        apply({ type: 'exit' });
      }
    },
    [apply],
  );

  const pinned = useCallback((): boolean => stateRef.current.pinned != null, []);

  // A plain literal: consumers destructure the stable functions immediately
  // (memoizing the object on `held` would hand every consumer a new identity
  // whenever the ack lands — see the RepeatOneApi doc).
  return {
    held,
    pinned,
    apply,
    renew,
    holdLease: hold,
    seamTarget,
    restartTarget,
    effectiveCrossfadeSeconds,
    onQueueSnapshot,
  };
}
