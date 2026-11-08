'use client';

// The Now Playing progress slider: elapsed
// time, Track length, and drag-to-scrub through the current Track. During a
// cold start the SAME bar doubles as the staged-progress surface:
// the synthetic time-based fill rides the slider and the staged copy
// renders in the middle label slot where "Track X/Y" normally shows, ending
// with the brief completion treatment when the wait resolves into a track.
// Outside a cold start the slot also carries the Session's status after the
// Track number ("Track 3/7 · Generating 2"), the one place the player says
// what the Session is doing; when new Tracks land, the total briefly flashes
// in the lamp colour and the arrival is announced.
//
// Self-contained by design. It polls `getPlaybackSample()` (~250 ms — also
// while paused, so an external lock-screen seek shows up) and keeps every
// high-frequency position value in ITS OWN state: position never enters
// `PlaybackControllerState`, which would re-render the whole card at slider
// frequency. The synthetic fill owns its tick the same way. A drag displays
// local state and commits exactly ONE seek on release, through the one
// controller funnel; the committed target is held optimistically until the
// sampled clock catches up (no visual snap-back). Every gesture is bound to
// the Track it started on — a Track change mid-drag kills the gesture, so
// release can never seek the replacement Track.

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveSeekTarget } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { prefersReducedMotion } from '@/lib/prefers-reduced-motion';
import { Slider } from '@/components/ui/slider';
import type { ColdStartNarration } from './cold-start-progress';
import { formatPlayerTime } from './player-time';
import { progressSliderShape } from './progress-slider';
import type { PlayableTrack } from './playable-track';
import type { PlaybackSample } from './playback-controller-api';
import type { SessionActivity } from './player-presentation';
import { useColdStartProgress } from './use-cold-start-progress';
import { pollWhileVisible } from './visible-poll';

const POLL_MS = 250;
/** How close the sampled clock must get to a committed target before the
 * optimistic hold releases — covers the funnel's 0.3 s end-guard clamp. */
const CATCH_UP_SECONDS = 0.5;
/** How many polls an optimistic hold may bridge before the truthful clock
 * wins regardless. The commit lands synchronously in practice, so the
 * catch-up release fires on the next poll; the backstop bounds how long any
 * pathological case — a superseding same-Track lock-screen seek right behind
 * the commit, a seek the funnel ended up rejecting — can stay masked. */
const COMMIT_HOLD_MAX_POLLS = 4;
/** How long the Track total holds its "new Tracks ready" flash — the length of
 * the `ready-flash` animation in globals.css. */
const READY_TICK_MS = 1500;
/** Keyboard step: ArrowRight advances 5 seconds. */
export const KEYBOARD_STEP_SECONDS = 5;
/** The readout line under a progress bar; each bar picks its own justification. */
export const progressLabelRowClass =
  'flex gap-3 whitespace-nowrap font-mono text-[10.5px] tracking-[0.08em] tabular-nums text-dim';
/** The staged fill's floor: a wait that has barely started still reads as a
 * visible sliver rather than an empty bar. */
const MIN_STAGED_PERCENT = 5;

/** A slider value bound to the Track it was produced on (by queueItemId). */
interface BoundValue {
  queueItemId: string;
  value: number;
}

/** A committed seek target held optimistically until the clock catches up
 * (or the poll backstop expires). */
interface CommittedHold extends BoundValue {
  pollsLeft: number;
}

export function TrackProgress({
  track,
  trackNumber,
  trackCount,
  getPlaybackSample,
  seekTo,
  staged,
  activity = null,
  newestQueueItemId,
}: {
  /** The audible Track (identity = queueItemId); null renders the idle bar. */
  track: PlayableTrack | null;
  /** 1-based position of the Track within the Session queue; null hides the readout. */
  trackNumber: number | null;
  /** Total tracks in the Session queue (grows as generation appends). */
  trackCount: number;
  getPlaybackSample: () => PlaybackSample;
  seekTo: (seconds: number) => void;
  /** The cold-start narration (`coldStartStagedCopy`), or null when not
   * cold-starting: the slider carries the synthetic fill and the copy takes
   * the middle label slot. */
  staged: ColdStartNarration | null;
  /** What the Session is doing (`presentSessionActivity`), read after the
   * Track number; a Playlist has no Session work and passes none. */
  activity?: SessionActivity | null;
  /** The Session's newest playable slot — generation appends there, so only a
   * change here can mean new Tracks landed. A Playlist generates nothing and
   * passes none. */
  newestQueueItemId?: string | null;
}) {
  const [sample, setSample] = useState<PlaybackSample | null>(null);
  // The thumb's local value while a drag is under way (polled changes ignored).
  const [drag, setDrag] = useState<BoundValue | null>(null);
  // The committed seek target, held until the sampled clock catches up.
  const [committed, setCommitted] = useState<CommittedHold | null>(null);
  // The live POINTER gesture — a ref because pointer events must read and
  // write it synchronously. Opened by pointer-down (capture, before Radix
  // jumps the value), closed by pointer-up/cancel AFTER Radix committed.
  // `cancelled` marks a gesture whose Track changed: every further value
  // change and the release itself are ignored. Keyboard steps never open a
  // gesture: Radix fires their `onValueCommit` BEFORE `onValueChange` (the
  // commit happens inside the same keydown), so a commit with no open
  // gesture IS the atomic keyboard seek.
  const gestureRef = useRef<{ queueItemId: string; cancelled: boolean } | null>(null);
  const queueItemId = track?.queueItemId ?? null;
  const { surface, fraction: stagedFraction } = useColdStartProgress(staged, trackCount > 0);

  // Poll the truthful clock while a Track is loaded (paused too — an external
  // lock-screen seek must appear here). Unchanged samples skip the write.
  useEffect(() => {
    if (!queueItemId) {
      setSample(null);
      return;
    }
    return pollWhileVisible(POLL_MS, () => {
      const next = getPlaybackSample();
      setSample((prev) =>
        prev &&
        prev.positionSeconds === next.positionSeconds &&
        prev.durationSeconds === next.durationSeconds
          ? prev
          : next,
      );
      // Release the optimistic hold once the clock caught up with its target —
      // resolved through the funnel's OWN clamp rule, because the commit may
      // have landed below the held value (stale queue metadata longer than
      // the asset, the end guard). The polls-left backstop then bounds how
      // long anything else can stay masked behind the hold.
      setCommitted((held) => {
        if (!held) return held;
        const target = resolveSeekTarget(held.value, next.durationSeconds) ?? held.value;
        if (next.positionSeconds != null && next.positionSeconds >= target - CATCH_UP_SECONDS) {
          return null;
        }
        return held.pollsLeft > 1 ? { ...held, pollsLeft: held.pollsLeft - 1 } : null;
      });
    });
  }, [queueItemId, getPlaybackSample]);

  // A Track change cancels an in-flight gesture and drops stale local values.
  useEffect(() => {
    const gesture = gestureRef.current;
    if (gesture && gesture.queueItemId !== queueItemId) gesture.cancelled = true;
    setDrag((d) => (d && d.queueItemId !== queueItemId ? null : d));
    setCommitted((held) => (held && held.queueItemId !== queueItemId ? null : held));
  }, [queueItemId]);

  // Duration resolves live sample → queue metadata → unknown. Unknown length
  // renders the explicit unknown form (–:––), an EMPTY bar, and disables
  // seeking entirely — the early stream phase plays before the provider has
  // reported a length, and the bar must claim nothing it doesn't know. The
  // geometry (max/value/seekability) is the pure `progressSliderShape`.
  const durationSeconds = sample?.durationSeconds ?? track?.durationSeconds ?? null;
  const positionSeconds = queueItemId
    ? (drag?.value ?? committed?.value ?? sample?.positionSeconds ?? null)
    : null;
  const shape = progressSliderShape(positionSeconds, durationSeconds);
  // While the cold-start surface rides the bar it shows ITS fill (a 0–100
  // synthetic percentage, or the completion snap) — a live seek gesture would
  // commit that percentage as SECONDS, so scrubbing stays off until the
  // surface ends.
  const coldStart = surface.kind !== 'none';
  const complete = surface.kind === 'complete';
  const percent = complete ? 100 : stagedFraction * 100;
  const seekable = queueItemId != null && shape.seekable && !coldStart;
  // No trustworthy length yet: the bar drops its knob until a real duration
  // lands. The ONE state that pulses is a Track already playing whose length
  // is still unknown (the early stream phase) — a faint full-width accent
  // fill throbbing over the steady grey backdrop. The staged cold-start fill
  // grows steadily, and the completion snap holds steady, visibly done.
  const indeterminate = coldStart || !shape.seekable;
  const shimmer = queueItemId != null && !coldStart && !shape.seekable;
  const sliderMax = coldStart ? 100 : shape.max;
  // The cold-start narration owns the label slot and the rail's fill, so the
  // Session status steps aside until the wait resolves.
  const shownActivity = coldStart ? null : activity;
  const readout = trackNumber != null && trackCount > 0;

  // New Tracks landed: how many, and whether the total flashes (reduced motion
  // keeps only the announcement). An arrival is a rise in the total that also
  // brings a new newest slot, within this mount and after the Queue's first
  // load: the player remounts the slider per Session, so a Session's opening
  // total never flashes; the server's played-slot window widening over older
  // Tracks leaves the newest slot alone; a Playlist passes no newest slot at
  // all. A drop (a Dislike removing a Track) cancels any flash in progress. A
  // cold start's first Tracks have their own completion treatment.
  const [readyTick, setReadyTick] = useState<{ added: number; flash: boolean } | null>(null);
  const seenRef = useRef({ total: trackCount, newest: newestQueueItemId });
  useEffect(() => {
    const previous = seenRef.current;
    seenRef.current = { total: trackCount, newest: newestQueueItemId };
    if (trackCount < previous.total) {
      setReadyTick(null);
      return;
    }
    const arrived =
      trackCount > previous.total &&
      previous.total > 0 &&
      newestQueueItemId != null &&
      newestQueueItemId !== previous.newest &&
      queueItemId != null &&
      !coldStart;
    if (!arrived) return;
    const added = trackCount - previous.total;
    // Arrivals landing mid-flash add up, so each one changes what is announced.
    setReadyTick((pending) => ({
      added: (pending?.added ?? 0) + added,
      flash: !prefersReducedMotion(),
    }));
  }, [trackCount, newestQueueItemId]);
  useEffect(() => {
    if (!readyTick) return;
    const id = setTimeout(() => setReadyTick(null), READY_TICK_MS);
    return () => clearTimeout(id);
  }, [readyTick]);

  let sliderValue = 0;
  if (coldStart) sliderValue = Math.max(percent, MIN_STAGED_PERCENT);
  else if (shimmer) sliderValue = shape.max;
  else if (queueItemId) sliderValue = shape.value;

  /** Open the pointer gesture (capture phase: before Radix's own pointer-down
   * handler jumps the value and emits the first change). */
  const onPointerDownCapture = useCallback(() => {
    if (queueItemId && seekable) gestureRef.current = { queueItemId, cancelled: false };
  }, [queueItemId, seekable]);

  /** Close the pointer gesture (bubble phase: Radix's root handler — the one
   * that fires `onValueCommit` — has already run). Also handles cancel. */
  const onPointerEnd = useCallback(() => {
    gestureRef.current = null;
    setDrag(null);
  }, []);

  const onValueChange = useCallback(
    ([value]: number[]) => {
      const gesture = gestureRef.current;
      // No open gesture = a keyboard step: its commit already fired (before
      // this change) and the committed hold displays the value — nothing to do.
      if (value == null || !gesture) return;
      if (gesture.cancelled || gesture.queueItemId !== queueItemId) return;
      setDrag({ queueItemId: gesture.queueItemId, value });
    },
    [queueItemId],
  );

  const onValueCommit = useCallback(
    ([value]: number[]) => {
      if (value == null || !queueItemId) return;
      const gesture = gestureRef.current;
      // A cancelled (or Track-crossed) pointer gesture must not seek the
      // replacement Track; a commit with NO gesture is a keyboard seek.
      if (gesture && (gesture.cancelled || gesture.queueItemId !== queueItemId)) return;
      seekTo(value);
      setCommitted({ queueItemId, value, pollsLeft: COMMIT_HOLD_MAX_POLLS });
    },
    [queueItemId, seekTo],
  );

  return (
    <div
      data-testid="track-progress"
      data-session-activity={shownActivity?.tone}
      className="w-full"
    >
      {/* Gesture bracket: capture-down opens BEFORE Radix jumps the value;
          bubble-up/cancel closes AFTER Radix's root handler committed. Radix
          sets pointer capture on its root, so the release always propagates
          through here even when the finger leaves the slider. */}
      <div
        role={coldStart ? 'progressbar' : undefined}
        aria-label={coldStart ? 'Preparing your session' : undefined}
        aria-valuemin={coldStart ? 0 : undefined}
        aria-valuemax={coldStart ? 100 : undefined}
        aria-valuenow={coldStart ? Math.round(percent) : undefined}
        onPointerDownCapture={onPointerDownCapture}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {/* The root's h-6 keeps a ≥24 px touch band around the slim visual bar. */}
        <Slider
          aria-label="Seek"
          aria-hidden={coldStart || undefined}
          className="h-6"
          min={0}
          max={sliderMax}
          step={KEYBOARD_STEP_SECONDS}
          value={[sliderValue]}
          disabled={!seekable}
          hideThumb={indeterminate}
          rangeClassName={cn(
            coldStart && 'transition-all duration-300 ease-out',
            shimmer && 'animate-progress-pulse bg-lamp/60',
            complete && 'bg-signal',
          )}
          // Active Session work lights the unplayed rail beneath the range in
          // a slow lamp breathe; under reduced motion the tint holds still.
          trackClassName={cn(
            shownActivity?.tone === 'active' &&
              'before:absolute before:inset-0 before:rounded-full before:bg-lamp/25 motion-safe:before:animate-gen-breathe',
          )}
          onValueChange={onValueChange}
          onValueCommit={onValueCommit}
        />
      </div>
      {/* One line at a fixed height: a long status truncates in the middle
          slot rather than wrapping and pushing the controls below. */}
      <div className={cn(progressLabelRowClass, 'justify-between')}>
        <span data-testid="progress-elapsed" className="shrink-0">
          {formatPlayerTime(queueItemId ? (positionSeconds ?? 0) : null)}
        </span>
        {coldStart ? (
          /* The staged narration takes the middle slot while the wait runs. */
          <span
            data-testid="progress-stage"
            aria-live="polite"
            className={cn(
              'max-w-[65%] truncate text-center',
              complete ? 'font-medium text-signal' : 'text-muted',
            )}
          >
            {complete ? 'Your session is ready' : surface.copy}
          </span>
        ) : readout || shownActivity ? (
          <span data-testid="progress-track-number" className="min-w-0 truncate text-center">
            {readout ? (
              <>
                Track {trackNumber}/
                {/* Keyed by the total so a second arrival mid-flash restarts
                    the animation. Colour and glow only: the readout never moves. */}
                <span
                  key={trackCount}
                  data-testid="progress-track-total"
                  data-ready-flash={readyTick?.flash ? '' : undefined}
                  className={cn(readyTick?.flash && 'animate-ready-flash')}
                >
                  {trackCount}
                </span>
                {/* The pulsing (stream-phase) bar names its wait: the Track
                    plays from the live stream while the final render — and
                    with it the real length — is still on its way. */}
                {shimmer ? (
                  <>
                    {' streaming'}
                    <span aria-hidden className="liedmotif-loading-dots">
                      <span>.</span>
                      <span>.</span>
                      <span>.</span>
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
            {/* Read out by the live region below, so it is heard once. */}
            {shownActivity ? (
              <span aria-hidden>
                {readout ? ' · ' : null}
                <span className={cn(shownActivity.tone === 'active' && 'font-medium text-lamp')}>
                  {shownActivity.label}
                </span>
              </span>
            ) : null}
          </span>
        ) : null}
        <span data-testid="progress-duration" className="shrink-0">
          {formatPlayerTime(durationSeconds)}
        </span>
      </div>
      {/* One polite region: an arrival is announced ahead of the status, never
          instead of it. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {[
          readyTick
            ? `${readyTick.added} new ${readyTick.added === 1 ? 'track' : 'tracks'} ready`
            : null,
          shownActivity?.label,
        ]
          .filter(Boolean)
          .join('. ')}
      </span>
    </div>
  );
}
