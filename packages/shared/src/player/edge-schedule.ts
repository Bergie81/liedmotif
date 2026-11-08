// Beat-aligned edge scheduling.
//
// An analyzed track carries TWO locally fitted beat grids — head and tail — each
// an anchor plus its own period (a single global BPM + head anchor cannot bound
// tail phase error under drift). The outgoing deck schedules against its TAIL
// grid, the incoming against its HEAD grid: the fade starts on a tail-grid beat
// at-or-before the deadline, runs a whole number of beats, and the incoming
// track is rate-locked so its head period matches the outgoing tail period.
//
// Pure math only; the engine maps the resulting media times onto the AudioContext
// clock and drives the automation.

/** One locally fitted beat grid: the first beat plus the fitted beat period. */
export interface BeatGrid {
  anchorSeconds: number;
  periodSeconds: number;
}

/** The latest grid beat at or before `timeSeconds`; null before the first beat. */
export function beatAtOrBefore(grid: BeatGrid, timeSeconds: number): number | null {
  if (grid.periodSeconds <= 0 || timeSeconds < grid.anchorSeconds) return null;
  const beats = Math.floor((timeSeconds - grid.anchorSeconds) / grid.periodSeconds);
  return grid.anchorSeconds + beats * grid.periodSeconds;
}

/** The crossfade length rounded to whole beats of `periodSeconds`, minimum 1. */
export function quantizedFadeBeats(crossfadeSeconds: number, periodSeconds: number): number {
  return Math.max(1, Math.round(crossfadeSeconds / periodSeconds));
}

/** A fully planned beat-aligned edge, in the OUTGOING track's media time. */
export interface AlignedEdgePlan {
  /** Outgoing media time at which the fade starts — always a tail-grid beat. */
  fadeStartSeconds: number;
  /** Fade length in OUTGOING MEDIA seconds: `fadeBeats` whole tail-grid beats.
   *  Divide by the outgoing playback rate for wall/context-clock seconds. */
  fadeSeconds: number;
  fadeBeats: number;
  /** Incoming `playbackRate` locking its head period onto the outgoing track's
   *  WALL-clock tail period (the outgoing deck's own rate nudge included). */
  incomingRate: number;
  /** Wall-clock seconds of incoming audio before its first head-grid beat (at rate). */
  incomingLeadSeconds: number;
}

/**
 * Plan a beat-aligned edge, or null when alignment cannot be honored and the
 * edge must degrade to a plain crossfade: no tail-grid beat exists at-or-before
 * the fade deadline, or that beat is already past `earliestStartSeconds` (the
 * current position plus scheduling lead). The fade length is the settings
 * crossfade quantized to whole tail-grid beats; it shortens only when the track
 * itself is too short to hold it — never to rescue a late preparation.
 */
export function planAlignedEdge(opts: {
  outDurationSeconds: number;
  outTail: BeatGrid;
  inHead: BeatGrid;
  crossfadeSeconds: number;
  earliestStartSeconds: number;
  /** The OUTGOING deck's current playback rate: after one aligned edge the
   *  active deck keeps its nudge, so the next edge must lock onto the
   *  outgoing WALL-clock period (`tailPeriod / rate`), not the media period. */
  outPlaybackRate?: number;
}): AlignedEdgePlan | null {
  const { outDurationSeconds, outTail, inHead, crossfadeSeconds, earliestStartSeconds } = opts;
  const outRate =
    opts.outPlaybackRate != null && opts.outPlaybackRate > 0 ? opts.outPlaybackRate : 1;
  if (outTail.periodSeconds <= 0 || inHead.periodSeconds <= 0) return null;

  // Shrink the whole-beat fade until it fits the track (a beat must exist
  // at-or-before the deadline `duration - fade`); below one beat, give up.
  // The crossfade setting is WALL seconds; one outgoing beat lasts
  // `tailPeriod / outRate` wall seconds, hence the rate factor.
  let fadeBeats = quantizedFadeBeats(crossfadeSeconds * outRate, outTail.periodSeconds);
  while (
    fadeBeats > 1 &&
    outDurationSeconds - fadeBeats * outTail.periodSeconds < outTail.anchorSeconds
  ) {
    fadeBeats -= 1;
  }
  const fadeSeconds = fadeBeats * outTail.periodSeconds;
  const deadline = outDurationSeconds - fadeSeconds;
  const fadeStartSeconds = beatAtOrBefore(outTail, deadline);
  if (fadeStartSeconds == null) return null;

  // Lock the incoming head period onto the outgoing WALL-clock tail period:
  // wall period = tailPeriod / outRate, so the rate multiplies in.
  const incomingRate = (outRate * inHead.periodSeconds) / outTail.periodSeconds;
  const incomingLeadSeconds = inHead.anchorSeconds / incomingRate;
  // BOTH scheduled moments must still be ahead: the fade start AND the
  // incoming element's pre-roll start (fade start minus the head-anchor lead).
  // A pre-roll that is already due would start late by its full lead — far
  // beyond the alignment budget — while still claiming the aligned tier.
  // (`fadeStart`/`earliest` are outgoing MEDIA seconds; the wall-clock lead
  // converts via the outgoing rate.)
  if (fadeStartSeconds - incomingLeadSeconds * outRate < earliestStartSeconds) return null;

  return {
    fadeStartSeconds,
    fadeSeconds,
    fadeBeats,
    incomingRate,
    incomingLeadSeconds,
  };
}

/**
 * The freshest element position from SEVERAL (mediaTime, contextTime) samples.
 * `HTMLMediaElement.currentTime` advances in quantized steps, so a
 * single raw sample UNDERSTATES the true position by up to one update
 * interval — which would place a sample-accurate buffer start late by that
 * bias on every mixed edge. Extrapolating every sample to `nowContextTime`
 * and keeping the MAXIMUM recovers the freshest update boundary (samples
 * taken right after an update dominate; stale ones fall below). Null without
 * samples.
 */
export function upperEnvelopePositionSeconds(
  samples: ReadonlyArray<{ mediaTime: number; contextTime: number }>,
  nowContextTime: number,
  playbackRate: number,
): number | null {
  const rate = playbackRate > 0 ? playbackRate : 1;
  let best = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    best = Math.max(best, sample.mediaTime + (nowContextTime - sample.contextTime) * rate);
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * Map a future outgoing-deck media time onto the AudioContext clock from one
 * sampled (mediaTime, contextTime) pair: media seconds advance `playbackRate`
 * times as fast as the context clock.
 *
 * `outputLatencySeconds` (context `baseLatency` + `outputLatency`, where
 * exposed): `HTMLMediaElement.currentTime`
 * approximates the PRESENTED (audible) position, while AudioParam automation
 * applies at RENDER time and only reaches the speakers after the output
 * pipeline. To make the fade land on the audible beat, the automation must be
 * scheduled EARLIER by that pipeline latency. Media-to-media alignment between
 * the two decks is unaffected (both shift equally) — this corrects the
 * fade-vs-audio placement.
 */
export function contextTimeForMediaTime(opts: {
  sample: { mediaTime: number; contextTime: number };
  targetMediaTime: number;
  playbackRate: number;
  outputLatencySeconds?: number;
}): number {
  const rate = opts.playbackRate > 0 ? opts.playbackRate : 1;
  return (
    opts.sample.contextTime +
    (opts.targetMediaTime - opts.sample.mediaTime) / rate -
    (opts.outputLatencySeconds ?? 0)
  );
}
