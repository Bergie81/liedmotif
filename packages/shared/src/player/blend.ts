// Live-blend math.
//
// Pure, deterministic DSP helpers the player's Web Audio wiring drives. Keeping the
// math here — framework- and DOM-free — is what makes the blend testable: jsdom
// cannot run a real audio graph, so the gain curves and conversions live as plain
// functions with unit coverage, and the thin engine just feeds these numbers to
// `GainNode`/`BiquadFilterNode`/`playbackRate`. The edge DECISIONS (tier, rate,
// mutual loudness, beat scheduling) live in edge-policy.ts / edge-loudness.ts /
// edge-schedule.ts alongside this file.

/** Default tail/head overlap for a crossfade and for a single-track loop seam. */
export const DEFAULT_CROSSFADE_SECONDS = 6;

/** Reference integrated loudness the player normalizes toward so blends don't pump. */
export const DEFAULT_TARGET_LUFS = -14;

/** Max absolute playback-time loudness correction, in dB (avoids wild boosts on a bad estimate). */
export const DEFAULT_MAX_LUFS_GAIN_DB = 12;

/**
 * Max fractional `playbackRate` nudge for a pitch-preserving media deck.
 * Generated tracks share the session's frozen BPM, so only
 * residual drift remains; a nudge beyond this cap degrades the edge to plain
 * instead of pitching/stretching a track audibly.
 */
export const PRESERVED_PITCH_RATE_CAP = 0.06;

/**
 * Max fractional rate change where a rate change SHIFTS PITCH (~26 cents): a
 * media deck without `preservesPitch` support, and buffer decks always
 * (`AudioBufferSourceNode` resamples without pitch correction).
 * Larger measured drift degrades the edge to plain.
 */
export const UNPRESERVED_PITCH_RATE_CAP = 0.015;

/** Bound `value` to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Equal-power crossfade gains at fade parameter `t` (0 = fully outgoing, 1 = fully
 * incoming). `out = cos(t·π/2)`, `in = sin(t·π/2)`, so `out² + in² = 1` holds at every
 * point — constant perceived power, no dip through the middle that a linear fade leaves.
 */
export function equalPowerGains(t: number): { outgoing: number; incoming: number } {
  const x = clamp(t, 0, 1) * (Math.PI / 2);
  return { outgoing: Math.cos(x), incoming: Math.sin(x) };
}

function equalPowerCurve(steps: number, fadeIn: boolean): Float32Array {
  if (!Number.isInteger(steps) || steps < 2) {
    throw new Error(`equal-power curve needs >= 2 steps, got ${steps}`);
  }
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const { outgoing, incoming } = equalPowerGains(t);
    curve[i] = fadeIn ? incoming : outgoing;
  }
  return curve;
}

/** Equal-power fade-IN gain ramp (0 → 1) for `AudioParam.setValueCurveAtTime`. */
export function equalPowerFadeInCurve(steps: number): Float32Array {
  return equalPowerCurve(steps, true);
}

/** Equal-power fade-OUT gain ramp (1 → 0), the complement of the fade-in curve. */
export function equalPowerFadeOutCurve(steps: number): Float32Array {
  return equalPowerCurve(steps, false);
}

/** Seconds per beat for a tempo, or null when the tempo is unknown/non-positive. */
export function beatPeriodSeconds(bpm: number | null | undefined): number | null {
  return bpm && bpm > 0 ? 60 / bpm : null;
}

/**
 * Playback-time loudness gain in dB: how much to raise/lower a track measured at
 * `measuredLufs` to reach `targetLufs`, clamped to ±`maxAbsDb`. 0 dB when loudness was
 * not measured. Paired with the equal-power crossfade so overlapping tracks don't pump.
 */
export function lufsGainDb(
  measuredLufs: number | null | undefined,
  targetLufs: number = DEFAULT_TARGET_LUFS,
  maxAbsDb: number = DEFAULT_MAX_LUFS_GAIN_DB,
): number {
  if (measuredLufs == null) return 0;
  return clamp(targetLufs - measuredLufs, -maxAbsDb, maxAbsDb);
}

/** Linear amplitude gain for a decibel value (`10^(dB/20)`). */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Decibel value for a positive linear gain (`20·log10(gain)`). */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain);
}

/**
 * When to begin the crossfade for a track of `durationSeconds`: one crossfade-length
 * before the end, or 0 if the track is shorter than the overlap (whole-track blend).
 */
export function crossfadeStartSeconds(
  durationSeconds: number,
  crossfadeSeconds: number = DEFAULT_CROSSFADE_SECONDS,
): number {
  return Math.max(0, durationSeconds - crossfadeSeconds);
}

/** Tail→head crossfade schedule for looping a single track (the loop seam). */
export interface LoopSeam {
  /** Position at which to start a second copy of the track from the head. */
  headStartAt: number;
  /** Overlap length, never more than half the track. */
  overlapSeconds: number;
  /** Where the head copy starts playing. */
  restartPosition: number;
}

/**
 * Loop a single track via a short tail→head crossfade: play the
 * tail while a fresh head copy fades in over `overlapSeconds`, hiding the seam. The
 * overlap is capped at half the track so a very short track still loops cleanly.
 */
export function loopSeam(
  durationSeconds: number,
  crossfadeSeconds: number = DEFAULT_CROSSFADE_SECONDS,
): LoopSeam {
  const overlapSeconds = Math.min(crossfadeSeconds, durationSeconds / 2);
  return {
    headStartAt: Math.max(0, durationSeconds - overlapSeconds),
    overlapSeconds,
    restartPosition: 0,
  };
}

/** Tracks shorter than this never seam-loop: they restart at natural end. */
export const MIN_LOOP_SEAM_TRACK_SECONDS = 15;

/** Whole bars (4 beats — the 4/4 the beat quantization assumes) a seam-looped track must hold. */
export const MIN_LOOP_SEAM_BARS = 2;

/**
 * Whether a pinned track can loop through the tail→head SEAM: it must hold the
 * minimum quantized fade — 2 bars at the generation-time target BPM — and at
 * least 15 s regardless. Too short → the loop falls back to a natural-end
 * restart (gap accepted; the toggle still works). An unknown duration cannot
 * be judged and refuses the seam the same way.
 */
export function loopSeamViable(
  durationSeconds: number | null | undefined,
  targetBpm: number | null | undefined,
): boolean {
  if (durationSeconds == null || durationSeconds < MIN_LOOP_SEAM_TRACK_SECONDS) return false;
  const beat = beatPeriodSeconds(targetBpm);
  return beat == null || durationSeconds >= MIN_LOOP_SEAM_BARS * 4 * beat;
}
