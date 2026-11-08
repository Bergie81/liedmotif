// The buffer↔buffer render of the DSP harness: one beat-locked edge
// planned by the REAL `planEdge` (transport 'buffer', both frames on the
// render clock), scheduled through the real graph with `source.start(when)` —
// exactly as the live `BufferDecks` transport starts it — then measured with
// band-separated, amplitude-invariant onset detectors against the thresholds
// table (scheduler error ≤ 1 ms, audible beat phase error ≤ 5 ms). Split from
// `harness.ts` so the shared render/measure primitives stay one module and
// the buffer-edge acceptance render another.

import {
  CURRENT_ANALYSIS_VERSION,
  dbToGain,
  soloLoudnessGainDb,
  UNPRESERVED_PITCH_RATE_CAP,
  type EdgeEndpoint,
} from '@liedmotif/shared';
import {
  createDeckChain,
  createMasterBus,
  scheduleCrossfadeAutomation,
  scheduleHardCut,
} from '@/components/player/blend-graph';
import { planEdge } from '@/components/player/edge-plan';
import {
  integratedLoudnessLufs,
  synthTrackPcm,
  truePeakDbOf,
  type SynthTrackSpec,
} from './harness';

/**
 * Band-separated onset times via an RBJ constant-peak band-pass biquad (Q = 4,
 * the same detector shape the real-time job taps with), run offline over the
 * rendered output. Onset placement is AMPLITUDE-INVARIANT: each burst's onset
 * is the first crossing of a threshold RELATIVE to that burst's own peak — an
 * absolute threshold would shift with playback gain (loudness normalization,
 * fades, the master trim) and pollute a millisecond-scale comparison against
 * the full-amplitude calibration fixture. The absolute `floor` only gates
 * burst DETECTION (skipping cross-band leakage and the fading tails).
 */
function bandPassOnsets(
  mono: Float32Array,
  sampleRate: number,
  centerHz: number,
  // High enough that cross-band click leakage and the melodic tones stay
  // undetected; the mid-overlap equal-power clicks sit well above it.
  floor = 0.05,
): number[] {
  const w0 = (2 * Math.PI * centerHz) / sampleRate;
  const alpha = Math.sin(w0) / 8; // Q = 4
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(mono.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < mono.length; i += 1) {
    const x0 = mono[i] ?? 0;
    const y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  const onsets: number[] = [];
  const burstWindow = Math.round(0.02 * sampleRate);
  const refractory = Math.round(0.05 * sampleRate);
  const RELATIVE_THRESHOLD = 0.35;
  let i = 0;
  while (i < y.length) {
    if (Math.abs(y[i] ?? 0) < floor) {
      i += 1;
      continue;
    }
    const end = Math.min(y.length, i + burstWindow);
    let peak = 0;
    for (let j = i; j < end; j += 1) {
      const v = Math.abs(y[j] ?? 0);
      if (v > peak) peak = v;
    }
    const rel = RELATIVE_THRESHOLD * peak;
    let onset = i;
    while (onset < end && Math.abs(y[onset] ?? 0) < rel) onset += 1;
    onsets.push(onset / sampleRate);
    i += refractory;
  }
  return onsets;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** A mono `AudioBuffer` from raw PCM (the harness feeds one channel per deck). */
function pcmToBuffer(
  ctx: BaseAudioContext,
  pcm: Float32Array<ArrayBuffer>,
  sampleRate: number,
): AudioBuffer {
  const buf = ctx.createBuffer(1, pcm.length, sampleRate);
  buf.copyToChannel(pcm, 0);
  return buf;
}

/** Average a rendered buffer's channels into one mono track for onset detection. */
function downmixToMono(rendered: AudioBuffer): Float32Array {
  const mono = new Float32Array(rendered.length);
  for (let chIdx = 0; chIdx < rendered.numberOfChannels; chIdx += 1) {
    const ch = rendered.getChannelData(chIdx);
    for (let i = 0; i < mono.length; i += 1) {
      mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / rendered.numberOfChannels;
    }
  }
  return mono;
}

export interface BufferEdgeMetrics {
  /** The edge policy's tier for the planned edge (must be `beat-locked`). */
  tier: string;
  /** |detected − planned| of the incoming beat grid AFTER the fade settles —
   *  how far `source.start(when, offset)` landed from the plan (median, ms,
   *  detector bias removed). Thresholds table: ≤ 1 ms. */
  schedulerErrorMs: number;
  /** Median folded mismatch between the two decks' AUDIBLE beats across the
   *  mid-overlap (ms, per-band detector bias removed). Thresholds: ≤ 5 ms. */
  beatPhaseErrorMs: number;
  /** Onset counts backing the two measurements — callers must reject vacuous
   *  passes (an undetected deck must FAIL, not measure nothing). */
  outgoingOnsets: number;
  incomingOnsets: number;
  settledOnsets: number;
  incomingRate: number;
  fadeStartSeconds: number;
  fadeSeconds: number;
}

/**
 * Render one BUFFER↔BUFFER beat-locked edge through the REAL pipeline: the
 * production `planEdge` (transport 'buffer', both frames on the render clock),
 * the real graph automation, and two `AudioBufferSourceNode`s — the incoming
 * one `start(when)`-scheduled sample-accurately at the planned rate, exactly
 * as the live `BufferDecks` transport starts it. The rendered output is then
 * measured with band-separated onset detectors (distinct click frequencies per
 * deck), detector bias calibrated per band against each fixture's raw PCM
 * ground truth.
 */
export async function renderBufferEdge(
  opts: { sampleRate?: number } = {},
): Promise<BufferEdgeMetrics> {
  const sampleRate = opts.sampleRate ?? 192_000;
  // Distinct click bands (2 octaves apart, both well above the 200 Hz bass
  // shelf) make each deck's audible beats attributable in the summed render.
  const out: SynthTrackSpec = {
    durationSeconds: 20,
    bpm: 120,
    anchorSeconds: 0.25,
    toneHz: 220,
    toneAmplitude: 0.2,
    clickAmplitude: 0.35,
    burstHz: 800,
    burstSeconds: 0.01,
  };
  // Off-target tempo: the plan must lock the incoming grid with a REAL rate.
  const inn: SynthTrackSpec = {
    durationSeconds: 12,
    bpm: 121.5,
    anchorSeconds: 0.3,
    toneHz: 277,
    toneAmplitude: 0.2,
    clickAmplitude: 0.35,
    burstHz: 3200,
    burstSeconds: 0.01,
  };
  const outPcm = synthTrackPcm(out, sampleRate);
  const inPcm = synthTrackPcm(inn, sampleRate);
  const outLufs = integratedLoudnessLufs(outPcm, sampleRate);
  const inLufs = integratedLoudnessLufs(inPcm, sampleRate);
  const outPeakDb = truePeakDbOf([outPcm]);
  const inPeakDb = truePeakDbOf([inPcm]);

  const endpoint = (spec: SynthTrackSpec, lufs: number, peakDb: number): EdgeEndpoint => ({
    source: 'final',
    styleRevision: 1,
    targetBpm: 120,
    targetKey: 'A minor',
    analysis: {
      version: CURRENT_ANALYSIS_VERSION,
      status: 'complete',
      bpm: spec.bpm,
      bpmSource: 'measured',
      bpmConfidence: 0.9,
      headBeatAnchorSeconds: spec.anchorSeconds,
      headBeatPeriodSeconds: 60 / spec.bpm,
      tailBeatAnchorSeconds: spec.anchorSeconds,
      tailBeatPeriodSeconds: 60 / spec.bpm,
      integratedLufs: lufs,
      truePeakDb: peakDb,
    },
  });

  // The REAL planner, sampled as the live driver samples a buffer-outgoing
  // deck: the render clock IS the media clock (source started at 0).
  const planned = planEdge({
    from: endpoint(out, outLufs, outPeakDb),
    to: endpoint(inn, inLufs, inPeakDb),
    fromLoudness: { lufs: outLufs, truePeakDb: outPeakDb },
    toLoudness: { lufs: inLufs, truePeakDb: inPeakDb },
    rateCapFraction: UNPRESERVED_PITCH_RATE_CAP,
    alignedSchedulingSupported: true,
    crossfadeSeconds: 4,
    outDurationSeconds: out.durationSeconds,
    outPositionSeconds: 12,
    outPlaybackRate: 1,
    nowContextTime: 12,
    clockLatencySeconds: 0.02,
    minLeadSeconds: 0.35,
    transport: 'buffer',
    outFrame: 'buffer',
    incomingTransport: 'buffer',
  });
  const aligned = planned.aligned;
  if (!aligned) {
    throw new Error(
      `buffer edge did not plan aligned: ${planned.decision.tier} ${planned.decision.reasons.join(',')}`,
    );
  }

  const fadeStart = aligned.fadeStartContextTime;
  const fadeEnd = fadeStart + aligned.fadeSeconds;
  const renderSeconds = fadeEnd + 3;
  const ctx = new OfflineAudioContext(2, Math.ceil(renderSeconds * sampleRate), sampleRate);
  const bus = createMasterBus(ctx);
  const chainA = createDeckChain(ctx, bus.master);
  const chainB = createDeckChain(ctx, bus.master);
  const srcA = ctx.createBufferSource();
  srcA.buffer = pcmToBuffer(ctx, outPcm, sampleRate);
  srcA.connect(chainA.input);
  const srcB = ctx.createBufferSource();
  srcB.buffer = pcmToBuffer(ctx, inPcm, sampleRate);
  srcB.playbackRate.value = aligned.incomingRate;
  srcB.connect(chainB.input);

  const outSoloDb = soloLoudnessGainDb({ lufs: outLufs, truePeakDb: outPeakDb });
  chainA.loud.gain.value = dbToGain(outSoloDb);
  scheduleHardCut([chainA, chainB], chainA, 0, outSoloDb);
  scheduleCrossfadeAutomation(chainA, chainB, {
    atContextTime: fadeStart,
    fadeSeconds: aligned.fadeSeconds,
    fromGainDb: planned.gains.fromDb,
    toGainDb: planned.gains.toDb,
    toSettleGainDb: soloLoudnessGainDb({ lufs: inLufs, truePeakDb: inPeakDb }),
  });
  srcA.start(0);
  // Exactly the live transport's start: `start(when, offset)` on the render clock.
  srcB.start(aligned.incomingStartContextTime, 0);

  const rendered = await ctx.startRendering();
  const mono = downmixToMono(rendered);

  // Per-band detector bias, calibrated through the FULL graph (a solo render
  // of each fixture at its edge rate through an identical bus): the master
  // compressor carries a fixed lookahead delay and the band-pass ring-up
  // differs per band — both would pollute a millisecond-scale comparison, and
  // both are constant, so a full-chain solo calibration removes them exactly.
  const calSeconds = 9;
  const calCtx = new OfflineAudioContext(2, Math.ceil(calSeconds * sampleRate), sampleRate);
  const calBus = createMasterBus(calCtx);
  const calA = createDeckChain(calCtx, calBus.master);
  const calB = createDeckChain(calCtx, calBus.master);
  const calSrcA = calCtx.createBufferSource();
  calSrcA.buffer = pcmToBuffer(calCtx, outPcm, sampleRate);
  calSrcA.connect(calA.input);
  const calSrcB = calCtx.createBufferSource();
  calSrcB.buffer = pcmToBuffer(calCtx, inPcm, sampleRate);
  calSrcB.playbackRate.value = aligned.incomingRate;
  calSrcB.connect(calB.input);
  scheduleHardCut([calA, calB], calA, 0, outSoloDb);
  scheduleHardCut(
    [calA, calB],
    calB,
    4,
    soloLoudnessGainDb({ lufs: inLufs, truePeakDb: inPeakDb }),
  );
  calSrcA.start(0, 0, 3);
  const calInStart = 4.5;
  calSrcB.start(calInStart, 0, 3);
  const calRendered = await calCtx.startRendering();
  const calMono = downmixToMono(calRendered);
  const outBias = (bandPassOnsets(calMono, sampleRate, out.burstHz!)[0] ?? 0) - out.anchorSeconds;
  const inBias =
    (bandPassOnsets(calMono, sampleRate, inn.burstHz!).find((t) => t >= calInStart) ?? 0) -
    (calInStart + inn.anchorSeconds / aligned.incomingRate);

  const outOnsets = bandPassOnsets(mono, sampleRate, out.burstHz!).map((t) => t - outBias);
  const inOnsets = bandPassOnsets(mono, sampleRate, inn.burstHz!).map((t) => t - inBias);

  // Scheduler error: where the incoming grid AUDIBLY landed once the fade
  // settled (full gain) vs where the plan put it.
  const inPeriod = 60 / inn.bpm / aligned.incomingRate;
  const plannedBeat = (t: number): number => {
    const first = aligned.incomingStartContextTime + inn.anchorSeconds / aligned.incomingRate;
    const k = Math.round((t - first) / inPeriod);
    return first + k * inPeriod;
  };
  const settled = inOnsets.filter((t) => t >= fadeEnd + 0.2 && t <= fadeEnd + 2.5);
  const schedulerErrorMs = median(settled.map((t) => Math.abs(t - plannedBeat(t)) * 1000));

  // Audible beat phase error across the mid-overlap (both decks audible under
  // the equal-power fade), folded by the overlap's wall-clock beat period.
  const wallPeriod = 60 / out.bpm;
  const midStart = fadeStart + aligned.fadeSeconds * 0.25;
  const midEnd = fadeStart + aligned.fadeSeconds * 0.75;
  const midOut = outOnsets.filter((t) => t >= midStart && t <= midEnd);
  const midIn = inOnsets.filter((t) => t >= midStart && t <= midEnd);
  const perBeat = midOut.map((b) => {
    const nearest = Math.min(...midIn.map((ib) => Math.abs(ib - b)));
    const folded = nearest % wallPeriod;
    return Math.min(folded, wallPeriod - folded) * 1000;
  });

  return {
    tier: planned.decision.tier,
    schedulerErrorMs,
    beatPhaseErrorMs: median(perBeat),
    outgoingOnsets: midOut.length,
    incomingOnsets: midIn.length,
    settledOnsets: settled.length,
    incomingRate: aligned.incomingRate,
    fadeStartSeconds: fadeStart,
    fadeSeconds: aligned.fadeSeconds,
  };
}
