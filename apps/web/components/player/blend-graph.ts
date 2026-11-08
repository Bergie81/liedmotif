// The live-blend graph and its click-safe automation, shared verbatim
// between the live `PlayerEngine` (media-element
// sources) and the offline DSP harness (buffer sources in an
// `OfflineAudioContext`). Everything here takes a `BaseAudioContext`, so the
// harness renders transitions through the REAL graph — same topology, same
// automation calls — and its true-peak/gap/loudness/click gates bind this code,
// not a lookalike.
//
// Click-safe automation: every re-automation first
// parks the param via `cancelAndHoldAtTime` where available (fallback:
// `cancelScheduledValues` + `setValueAtTime(current)`), steps go through
// `setTargetAtTime` with τ ≈ 15 ms, and fades are equal-power
// `setValueCurveAtTime` ramps scheduled on a parked param.

import { dbToGain, equalPowerFadeInCurve, equalPowerFadeOutCurve } from '@liedmotif/shared';

/** Decibels the outgoing low shelf is cut to during a transition (bass-swap). */
export const BASS_SWAP_CUT_DB = -12;
/** Samples in an equal-power gain ramp (smooth enough for a 12 s fade). */
const FADE_CURVE_STEPS = 64;
const FADE_IN_CURVE = equalPowerFadeInCurve(FADE_CURVE_STEPS);
const FADE_OUT_CURVE = equalPowerFadeOutCurve(FADE_CURVE_STEPS);
/** Time constant for click-safe stepped parameter moves (τ ≈ 15 ms). */
export const STEP_TIME_CONSTANT_SECONDS = 0.015;

/** One deck's processing chain: source → bass shelf → loudness gain → fade gain. */
export interface DeckChain {
  /** Where the deck's source node connects. */
  input: AudioNode;
  bass: BiquadFilterNode;
  loud: GainNode;
  fade: GainNode;
}

/**
 * Park a param at `atTime`: cancel scheduled automation while HOLDING the
 * current value (no instantaneous jump). `cancelAndHoldAtTime` where the
 * browser has it (typed in lib.dom but missing at runtime on e.g. older
 * Firefox); otherwise cancel + re-pin the current value.
 */
export function holdParam(param: AudioParam, atTime: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(atTime);
  } else {
    const current = param.value;
    param.cancelScheduledValues(atTime);
    param.setValueAtTime(current, atTime);
  }
}

/** Click-safe stepped move: park, then approach `value` with τ ≈ 15 ms. */
export function stepParam(param: AudioParam, value: number, atTime: number): void {
  holdParam(param, atTime);
  param.setTargetAtTime(value, atTime, STEP_TIME_CONSTANT_SECONDS);
}

/** Build one deck chain into `destination` (fade gain starts silent). */
export function createDeckChain(ctx: BaseAudioContext, destination: AudioNode): DeckChain {
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 200;
  bass.gain.value = 0;
  const loud = ctx.createGain();
  loud.gain.value = 1;
  const fade = ctx.createGain();
  fade.gain.value = 0;
  bass.connect(loud).connect(fade).connect(destination);
  return { input: bass, bass, loud, fade };
}

/** The shared output bus: master gain → compressor backstop → destination. */
export interface MasterBus {
  master: GainNode;
  compressor: DynamicsCompressorNode;
}

/** Master compressor backstop parameters (knee 0 keeps the makeup math exact). */
const COMPRESSOR_THRESHOLD_DB = -3;
const COMPRESSOR_RATIO = 12;

/**
 * Build the master bus. The `DynamicsCompressorNode` is a BACKSTOP only — it is
 * not a brick-wall true-peak limiter (MDN); the real guarantee is the measured,
 * oversampled true peak of the summed render combined with
 * mutual-target attenuation and the −1 dBTP boost clamp.
 *
 * The Web Audio spec's compressor applies AUTOMATIC makeup gain of
 * `(1 / fullRangeGain)^0.6`, where `fullRangeGain` is the compression curve
 * evaluated at 0 dBFS — i.e. it silently BOOSTS everything below threshold,
 * which would defeat the headroom the normalization just guaranteed. The trim
 * gain after the compressor cancels exactly that spec-defined makeup.
 */
export function createMasterBus(ctx: BaseAudioContext): MasterBus {
  const master = ctx.createGain();
  master.gain.value = 1;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR_THRESHOLD_DB;
  compressor.knee.value = 0;
  compressor.ratio.value = COMPRESSOR_RATIO;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  // Curve at 0 dBFS input (knee 0): threshold + (0 - threshold) / ratio.
  const curveAtZeroDb = COMPRESSOR_THRESHOLD_DB - COMPRESSOR_THRESHOLD_DB / COMPRESSOR_RATIO;
  const makeupTrim = ctx.createGain();
  makeupTrim.gain.value = Math.pow(10, (0.6 * curveAtZeroDb) / 20);
  master.connect(compressor).connect(makeupTrim).connect(ctx.destination);
  return { master, compressor };
}

/** The automation for one crossfade edge, at absolute context times. */
export interface CrossfadeAutomation {
  /** Context time the fade starts (schedule in the future for aligned edges). */
  atContextTime: number;
  fadeSeconds: number;
  /** Mutual-target loudness gains (dB) applied to each deck for this edge. */
  fromGainDb: number;
  toGainDb: number;
  /** The incoming deck's SOLO gain, restored once the fade completes — the
   *  mutual overlap gain must not stick for the rest of the track. */
  toSettleGainDb: number;
}

/**
 * Schedule one equal-power crossfade through the chains: fade curves on both
 * decks' fade gains, the bass-swap on the outgoing shelf, and the mutual-target
 * loudness gains (settling the incoming deck back to its solo gain after the
 * overlap). All parameters are parked first, so re-automation mid-fade cannot
 * click.
 */
export function scheduleCrossfadeAutomation(
  from: DeckChain,
  to: DeckChain,
  automation: CrossfadeAutomation,
): void {
  const { atContextTime: at, fadeSeconds } = automation;
  // Loudness: the incoming deck's gain applies before it becomes audible; the
  // outgoing deck moves toward the mutual target as the fade starts; after the
  // overlap the incoming deck settles at its own solo normalization.
  stepParam(to.loud.gain, dbToGain(automation.toGainDb), at);
  stepParam(from.loud.gain, dbToGain(automation.fromGainDb), at);
  to.loud.gain.setTargetAtTime(
    dbToGain(automation.toSettleGainDb),
    at + fadeSeconds,
    STEP_TIME_CONSTANT_SECONDS,
  );

  holdParam(from.fade.gain, at);
  holdParam(to.fade.gain, at);
  from.fade.gain.setValueAtTime(1, at);
  to.fade.gain.setValueAtTime(0, at);
  from.fade.gain.setValueCurveAtTime(FADE_OUT_CURVE, at, fadeSeconds);
  to.fade.gain.setValueCurveAtTime(FADE_IN_CURVE, at, fadeSeconds);

  // Bass-swap: cut the outgoing low end as it leaves; the incoming keeps full bass.
  holdParam(from.bass.gain, at);
  from.bass.gain.setValueAtTime(from.bass.gain.value, at);
  from.bass.gain.linearRampToValueAtTime(BASS_SWAP_CUT_DB, at + fadeSeconds);
  stepParam(to.bass.gain, 0, at);
}

/**
 * Park EVERY parameter of both edge chains at its current value: cancels any
 * armed or half-scheduled automation without moving the audible level. The
 * recovery step when scheduling threw partway through (some params may already
 * carry automation, some not) — shared by the engine's failure path and the
 * harness's failure-sequence render so both execute the same recovery.
 */
export function parkEdgeAutomation(from: DeckChain, to: DeckChain, atTime: number): void {
  for (const chain of [from, to]) {
    for (const param of [chain.fade.gain, chain.loud.gain, chain.bass.gain]) {
      try {
        holdParam(param, atTime);
      } catch {
        // Park what we can; the caller degrades the edge either way.
      }
    }
  }
}

/**
 * The ONE attempt-and-recover operation for arming a crossfade — used verbatim
 * by the live engine and the harness's failure render, so the recovery the
 * tests measure is the recovery production runs. True when the automation was
 * fully armed; false when an AudioParam call threw — every touched parameter
 * is then parked at `parkAtTime` (the live engine passes its context "now";
 * the offline harness passes the failure's position in its render timeline)
 * and the CALLER must degrade the edge.
 */
export function attemptCrossfadeAutomation(
  from: DeckChain,
  to: DeckChain,
  automation: CrossfadeAutomation,
  parkAtTime: number,
): boolean {
  try {
    scheduleCrossfadeAutomation(from, to, automation);
    return true;
  } catch {
    parkEdgeAutomation(from, to, parkAtTime);
    return false;
  }
}

/**
 * The LAST-RESORT cut when even the click-safe automation primitives throw:
 * best-effort cancellation of anything still scheduled (a direct `.value`
 * assignment does NOT remove scheduled events, which would otherwise keep
 * driving the params), then direct `AudioParam.value` assignment — a WebIDL
 * attribute set, which cannot throw, so the final step is non-throwing BY
 * CONSTRUCTION. It is deliberately an instantaneous gain step: audible over
 * elegant, never silent. (The discontinuity is the accepted cost of the deepest
 * emergency.)
 */
export function emergencyHardCut(
  chains: readonly DeckChain[],
  active: DeckChain,
  atTime: number,
  activeLoudGainDb: number,
): void {
  for (const chain of chains) {
    for (const param of [chain.fade.gain, chain.loud.gain, chain.bass.gain]) {
      try {
        param.cancelScheduledValues(atTime);
      } catch {
        // Cancel what we can; the direct assignments below cannot throw.
      }
    }
    chain.fade.gain.value = chain === active ? 1 : 0;
    chain.bass.gain.value = 0;
    if (chain === active) chain.loud.gain.value = dbToGain(activeLoudGainDb);
  }
}

/**
 * The ONE hard-cut recovery operation shared by the live engine and the
 * harness's failure render: attempt the click-safe cut; when its automation
 * primitives throw (possibly PARTWAY through — some params already stepped),
 * fall through to the emergency direct-value cut. True when the click-safe
 * path succeeded.
 */
export function hardCutOrEmergency(
  chains: readonly DeckChain[],
  active: DeckChain,
  atTime: number,
  activeLoudGainDb: number,
): boolean {
  try {
    scheduleHardCut(chains, active, atTime, activeLoudGainDb);
    return true;
  } catch {
    emergencyHardCut(chains, active, atTime, activeLoudGainDb);
    return false;
  }
}

/**
 * Make exactly one deck audible NOW (cold-start entry / recovery, and the
 * settle path after a cancelled edge): the active deck steps to full fade gain
 * AND to its intended loudness gain; every other chain steps to silence. Every
 * automated parameter — fade, bass, and loudness — is parked or re-targeted,
 * so a cancelled scheduled edge leaves no pending gain change armed for its
 * original fade time. The active loudness gain is part of THIS call, not a
 * separate step: a hold scheduled after a separate loudness step would cancel
 * that step near its start value. Click-safe.
 */
export function scheduleHardCut(
  chains: readonly DeckChain[],
  active: DeckChain,
  atTime: number,
  activeLoudGainDb: number,
): void {
  for (const chain of chains) {
    stepParam(chain.fade.gain, chain === active ? 1 : 0, atTime);
    stepParam(chain.bass.gain, 0, atTime);
    if (chain === active) {
      stepParam(chain.loud.gain, dbToGain(activeLoudGainDb), atTime);
    } else {
      // Park the inactive loudness gain: cancels any scheduled mutual-target/
      // settle steps without moving the (inaudible) level.
      holdParam(chain.loud.gain, atTime);
    }
  }
}
