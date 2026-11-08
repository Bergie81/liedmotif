// The offline-render DSP harness.
//
// Renders transitions through the REAL blend graph (`blend-graph.ts` — the same
// topology and automation calls the live PlayerEngine drives) inside an
// `OfflineAudioContext`, and measures the thresholds-table gates on the summed
// render: oversampled true peak, output gap, K-weighted short-term loudness
// delta, and the click detector. Rendering at 192 kHz makes every peak reading
// ≥4× oversampled relative to the 48 kHz playback rate.
//
// This harness verifies DSP correctness, not live media-element scheduling or
// start jitter.
//
// Everything is deterministic: fixtures are synthesized click-plus-tone tracks,
// no randomness, no wall clock.

import {
  dbToGain,
  loopSeam,
  mutualLoudnessGainsDb,
  planAlignedEdge,
  soloLoudnessGainDb,
  type AlignedEdgePlan,
} from '@liedmotif/shared';
import {
  attemptCrossfadeAutomation,
  createDeckChain,
  createMasterBus,
  hardCutOrEmergency,
  scheduleCrossfadeAutomation,
  scheduleHardCut,
} from '@/components/player/blend-graph';

// --- Synthetic fixtures --------------------------------------------------------

export interface SynthTrackSpec {
  durationSeconds: number;
  bpm: number;
  /** First beat time (the head anchor of the synthetic grid). */
  anchorSeconds: number;
  /** Sustained tone underneath the clicks (keeps short-term loudness measurable). */
  toneHz: number;
  toneAmplitude: number;
  /** Short click at every beat (what the click detector must NOT flag: it is
   *  program material, hence clicks are band-limited sine bursts, not steps). */
  clickAmplitude: number;
  /** Burst length (default 20 ms). The correlated true-peak fixture uses ~1 ms
   *  — a kick-like transient FASTER than the compressor's 3 ms attack. */
  burstSeconds?: number;
  /** Burst tone (default 500 Hz — per-sample slope well under the click gate). */
  burstHz?: number;
}

/** Synthesize one deterministic beat-grid track as a mono Float32Array. */
export function synthTrackPcm(spec: SynthTrackSpec, sampleRate: number): Float32Array<ArrayBuffer> {
  const length = Math.round(spec.durationSeconds * sampleRate);
  const pcm = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    pcm[i] = spec.toneAmplitude * Math.sin((2 * Math.PI * spec.toneHz * i) / sampleRate);
  }
  const period = 60 / spec.bpm;
  const burstSeconds = spec.burstSeconds ?? 0.02;
  const burstHz = spec.burstHz ?? 500;
  const burstSamples = Math.round(burstSeconds * sampleRate);
  for (let beat = spec.anchorSeconds; beat < spec.durationSeconds; beat += period) {
    const start = Math.round(beat * sampleRate);
    for (let i = 0; i < burstSamples && start + i < length; i += 1) {
      // Hann-windowed sine burst: audible click, no step discontinuity. At the
      // 500 Hz/20 ms default the click detector (which gates SAMPLE STEPS —
      // automation artifacts) stays well clear even when two rate-locked
      // tracks' bursts land sample-coincident mid-overlap and their slopes sum.
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / burstSamples));
      pcm[start + i] =
        (pcm[start + i] ?? 0) +
        spec.clickAmplitude * w * Math.sin((2 * Math.PI * burstHz * i) / sampleRate);
    }
  }
  return pcm;
}

// --- BS.1770 K-weighting + loudness --------------------------------------------

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** BS.1770 stage-1 high-shelf, coefficients for an arbitrary sample rate
 *  (pyloudnorm/libebur128 parameterization). */
function kWeightShelf(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const den = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / den,
    b1: (2 * (K * K - Vh)) / den,
    b2: (Vh - (Vb * K) / Q + K * K) / den,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  };
}

/** BS.1770 stage-2 RLB high-pass for an arbitrary sample rate. */
function kWeightHighPass(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const den = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / den,
    a2: (1 - K / Q + K * K) / den,
  };
}

function applyBiquad(input: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i] ?? 0;
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function kWeight(samples: Float32Array, sampleRate: number): Float32Array {
  return applyBiquad(applyBiquad(samples, kWeightShelf(sampleRate)), kWeightHighPass(sampleRate));
}

function meanSquare(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  const from = Math.max(0, start);
  const to = Math.min(samples.length, end);
  for (let i = from; i < to; i += 1) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return to > from ? sum / (to - from) : 0;
}

const LOUDNESS_OFFSET_LU = -0.691;

/**
 * BS.1770 integrated loudness of mono K-weighted-able samples (channel weight 1):
 * 400 ms blocks at 100 ms hop, −70 LUFS absolute gate, then the −10 LU relative
 * gate. Returns −Infinity for silence.
 */
export function integratedLoudnessLufs(samples: Float32Array, sampleRate: number): number {
  const weighted = kWeight(samples, sampleRate);
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blocks: number[] = [];
  for (let start = 0; start + block <= weighted.length; start += hop) {
    blocks.push(meanSquare(weighted, start, start + block));
  }
  const loudnessOf = (ms: number) => LOUDNESS_OFFSET_LU + 10 * Math.log10(Math.max(ms, 1e-12));
  const absGated = blocks.filter((ms) => loudnessOf(ms) > -70);
  if (absGated.length === 0) return Number.NEGATIVE_INFINITY;
  const absMean = absGated.reduce((a, b) => a + b, 0) / absGated.length;
  const relThreshold = loudnessOf(absMean) - 10;
  const relGated = absGated.filter((ms) => loudnessOf(ms) > relThreshold);
  if (relGated.length === 0) return Number.NEGATIVE_INFINITY;
  return loudnessOf(relGated.reduce((a, b) => a + b, 0) / relGated.length);
}

/** Short-term K-weighted loudness series at 100 ms hop: `[timeSeconds, lufs]`.
 * The window defaults to the BS.1770 short-term 3 s; the overlap gate shrinks
 * it to the fade length when the fade is shorter, so a 2 s minimum fade is
 * still measurable instead of silently unmeasured. */
export function shortTermLoudnessSeries(
  samples: Float32Array,
  sampleRate: number,
  windowSeconds = 3,
): Array<[number, number]> {
  const weighted = kWeight(samples, sampleRate);
  const block = Math.round(windowSeconds * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const series: Array<[number, number]> = [];
  for (let start = 0; start + block <= weighted.length; start += hop) {
    const lufs =
      LOUDNESS_OFFSET_LU +
      10 * Math.log10(Math.max(meanSquare(weighted, start, start + block), 1e-12));
    series.push([(start + block / 2) / sampleRate, lufs]);
  }
  return series;
}

// --- Render + metrics -----------------------------------------------------------

export interface RenderEdgeOptions {
  /** ≥4× oversampled relative to 48 kHz playback (default 192 kHz). */
  sampleRate?: number;
  out: SynthTrackSpec;
  in: SynthTrackSpec;
  /** Fade start in the outgoing track's timeline (= render timeline). */
  fadeStartSeconds: number;
  fadeSeconds: number;
  /** When the incoming source starts (its media time 0), in render time. */
  incomingStartSeconds: number;
  /** Loudness gains; 'mutual' derives them from the two measured fixtures. */
  gains: { fromDb: number; toDb: number } | 'mutual';
  /**
   * Render the AUTOMATION-FAILURE sequence instead of the fade: an injected
   * exception mid-automation (a genuinely partial schedule), the SHARED
   * attempt/park recovery (`attemptCrossfadeAutomation` — the same operation
   * the live engine runs), then the production fallback. 'clicksafe' ends in
   * the click-safe hard cut; 'emergency' ends in the direct-value emergency
   * cut (the deepest fallback, whose instantaneous step is deliberately
   * outside the click gate — assert peak/gap/energy instead).
   */
  simulateAutomationFailure?: 'clicksafe' | 'emergency';
}

export interface EdgeMetrics {
  /** Max absolute sample of the summed render, in dBTP (≥4× oversampled). */
  truePeakDb: number;
  /** Longest near-silent (−60 dBFS RMS over 5 ms) run inside the transition, ms. */
  outputGapMs: number;
  /** Max |sample step| within the automation windows (click detector). */
  clickMaxStep: number;
  /** Max |short-term loudness − mutual target| across the transition window,
   *  LU — or null when it could NOT be measured (no mutual target, or no
   *  window fit inside the overlap). Callers must reject null where they
   *  assert the loudness gate; a silent zero would fake compliance. */
  loudnessDeltaLu: number | null;
  /** The mutual target the gains aimed at (measured fixtures + shared math). */
  mutualTargetLufs: number | null;
  appliedGains: { fromDb: number; toDb: number };
  /** Measured integrated loudness of the raw fixtures (diagnostics). */
  fixtureLufs: { out: number; in: number };
  /** Tone energy AFTER the transition settled: the incoming deck must have
   *  WON (its tone dominating, the outgoing suppressed) — asserted for the
   *  failure-recovery renders, where "non-silent" alone would not prove it. */
  postTransition: { outgoingToneDb: number; incomingToneDb: number };
}

/** Goertzel single-bin energy (dB) of `mono` in [t0, t1) at `freqHz`. */
function toneEnergyDb(
  mono: Float32Array,
  sampleRate: number,
  freqHz: number,
  t0: number,
  t1: number,
): number {
  const start = Math.max(0, Math.round(t0 * sampleRate));
  const end = Math.min(mono.length, Math.round(t1 * sampleRate));
  const n = end - start;
  if (n <= 0) return Number.NEGATIVE_INFINITY;
  const k = Math.round((freqHz / sampleRate) * n);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = start; i < end; i += 1) {
    const s0 = (mono[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n);
  return 10 * Math.log10(Math.max(power, 1e-16));
}

/** Max absolute sample in dBTP (exact for synthesized/rendered PCM). */
export function truePeakDbOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const v = Math.abs(ch[i] ?? 0);
      if (v > peak) peak = v;
    }
  }
  return 20 * Math.log10(Math.max(peak, 1e-12));
}

function longestGapMs(
  mono: Float32Array,
  sampleRate: number,
  fromSeconds: number,
  toSeconds: number,
): number {
  const win = Math.round(0.005 * sampleRate);
  const start = Math.max(0, Math.round(fromSeconds * sampleRate));
  const end = Math.min(mono.length, Math.round(toSeconds * sampleRate));
  let longest = 0;
  let run = 0;
  for (let s = start; s + win <= end; s += win) {
    const rms = Math.sqrt(meanSquare(mono, s, s + win));
    if (rms < 1e-3) {
      run += win;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return (longest / sampleRate) * 1000;
}

function maxStepIn(
  channels: Float32Array[],
  sampleRate: number,
  windows: Array<[number, number]>,
): number {
  let max = 0;
  for (const ch of channels) {
    for (const [from, to] of windows) {
      const start = Math.max(1, Math.round(from * sampleRate));
      const end = Math.min(ch.length, Math.round(to * sampleRate));
      for (let i = start; i < end; i += 1) {
        const step = Math.abs((ch[i] ?? 0) - (ch[i - 1] ?? 0));
        if (step > max) max = step;
      }
    }
  }
  return max;
}

/**
 * Render one transition through the real graph and measure the gates. The
 * fixtures' loudness is MEASURED (not assumed) with the same BS.1770 code the
 * assertions use, and 'mutual' gains go through the production
 * `mutualLoudnessGainsDb` — so the harness exercises the real normalization
 * math end to end.
 */
export async function renderEdge(opts: RenderEdgeOptions): Promise<EdgeMetrics> {
  const sampleRate = opts.sampleRate ?? 192_000;
  const outPcm = synthTrackPcm(opts.out, sampleRate);
  const inPcm = synthTrackPcm(opts.in, sampleRate);
  const outLufs = integratedLoudnessLufs(outPcm, sampleRate);
  const inLufs = integratedLoudnessLufs(inPcm, sampleRate);

  // Fixture true peaks for the headroom clamp: exact from the synthesized PCM.
  const outPeakDb = truePeakDbOf([outPcm]);
  const inPeakDb = truePeakDbOf([inPcm]);
  const mutual = mutualLoudnessGainsDb(
    { lufs: outLufs, truePeakDb: outPeakDb },
    { lufs: inLufs, truePeakDb: inPeakDb },
  );
  const gains = opts.gains === 'mutual' ? { fromDb: mutual.fromDb, toDb: mutual.toDb } : opts.gains;

  const tailSeconds = Math.max(
    opts.out.durationSeconds,
    opts.incomingStartSeconds + opts.in.durationSeconds,
  );
  const renderSeconds = Math.min(tailSeconds, opts.fadeStartSeconds + opts.fadeSeconds + 3);
  const ctx = new OfflineAudioContext(2, Math.ceil(renderSeconds * sampleRate), sampleRate);
  // Set only by the 'emergency' failure render (resolves during rendering).
  let pendingSuspend: Promise<void> | null = null;

  const bus = createMasterBus(ctx);
  const chainA = createDeckChain(ctx, bus.master);
  const chainB = createDeckChain(ctx, bus.master);

  const toBuffer = (pcm: Float32Array<ArrayBuffer>) => {
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    return buf;
  };
  const srcA = ctx.createBufferSource();
  srcA.buffer = toBuffer(outPcm);
  srcA.connect(chainA.input);
  const srcB = ctx.createBufferSource();
  srcB.buffer = toBuffer(inPcm);
  srcB.connect(chainB.input);

  // The real automation calls, exactly as the engine drives them. With
  // 'mutual' gains the outgoing deck starts at its SOLO normalization gain
  // (what the live hard cut applies), so the pre-edge state matches live
  // playback; explicit gains render RAW (`fromDb` as the steady pre-fade
  // state) so worst cases aren't normalized away before they can be measured.
  const outSteadyDb =
    opts.gains === 'mutual'
      ? soloLoudnessGainDb({ lufs: outLufs, truePeakDb: outPeakDb })
      : opts.gains.fromDb;
  const settleDb =
    opts.gains === 'mutual'
      ? soloLoudnessGainDb({ lufs: inLufs, truePeakDb: inPeakDb })
      : opts.gains.toDb;
  chainA.loud.gain.value = dbToGain(outSteadyDb);
  scheduleHardCut([chainA, chainB], chainA, 0, outSteadyDb);
  if (opts.simulateAutomationFailure) {
    // Render the ACTUAL failure-and-recovery sequence, not just the desired
    // outcome: inject an exception into one fade param mid-automation (some
    // params are already scheduled by then — a genuinely PARTIAL schedule) and
    // run the SAME attempt/park operation the live engine runs. The parking
    // time is the failure's position in this offline timeline (the live
    // engine passes its context "now").
    const original = chainB.fade.gain.setValueCurveAtTime.bind(chainB.fade.gain);
    chainB.fade.gain.setValueCurveAtTime = () => {
      throw new DOMException('injected automation failure', 'NotSupportedError');
    };
    const armed = attemptCrossfadeAutomation(
      chainA,
      chainB,
      {
        atContextTime: opts.fadeStartSeconds,
        fadeSeconds: opts.fadeSeconds,
        fromGainDb: gains.fromDb,
        toGainDb: gains.toDb,
        toSettleGainDb: settleDb,
      },
      opts.fadeStartSeconds,
    );
    chainB.fade.gain.setValueCurveAtTime = original;
    if (armed) throw new Error('failure injection did not fire');
    if (opts.simulateAutomationFailure === 'emergency') {
      // The deepest fallback runs through the SAME shared operation production
      // uses (`hardCutOrEmergency`) with its click-safe primitive throwing
      // PARTWAY through (fade steps land, the loudness step throws) — a
      // genuinely partial hard-cut attempt, then the emergency direct-value
      // cut. Offline, "now" is emulated by suspending the render clock at the
      // failure moment; the suspend promise resolves DURING rendering and is
      // awaited alongside startRendering.
      pendingSuspend = ctx.suspend(opts.fadeStartSeconds).then(() => {
        const originalStep = chainB.loud.gain.setTargetAtTime.bind(chainB.loud.gain);
        chainB.loud.gain.setTargetAtTime = () => {
          throw new DOMException('injected primitive failure', 'NotSupportedError');
        };
        const clickSafe = hardCutOrEmergency(
          [chainA, chainB],
          chainB,
          opts.fadeStartSeconds,
          settleDb,
        );
        chainB.loud.gain.setTargetAtTime = originalStep;
        if (clickSafe) throw new Error('hard-cut failure injection did not fire');
        return ctx.resume();
      });
    } else {
      scheduleHardCut([chainA, chainB], chainB, opts.fadeStartSeconds, settleDb);
    }
  } else {
    scheduleCrossfadeAutomation(chainA, chainB, {
      atContextTime: opts.fadeStartSeconds,
      fadeSeconds: opts.fadeSeconds,
      fromGainDb: gains.fromDb,
      toGainDb: gains.toDb,
      toSettleGainDb: settleDb,
    });
  }
  srcA.start(0);
  srcB.start(opts.incomingStartSeconds);

  const [rendered] = await Promise.all([ctx.startRendering(), pendingSuspend]);
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, i) =>
    rendered.getChannelData(i),
  );
  const mono = new Float32Array(rendered.length);
  for (const ch of channels) {
    for (let i = 0; i < mono.length; i += 1)
      mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / channels.length;
  }

  const fadeEnd = opts.fadeStartSeconds + opts.fadeSeconds;
  // The loudness window shrinks to the fade length for short fades — the 2 s
  // minimum setting must be measurable, not silently skipped.
  const loudnessWindow = Math.min(3, opts.fadeSeconds);
  const series = shortTermLoudnessSeries(mono, sampleRate, loudnessWindow);
  const target = mutual.mutualTargetLufs;
  let loudnessDeltaLu: number | null = null;
  if (target != null) {
    for (const [t, lufs] of series) {
      // Judge only windows FULLY inside the overlap (the loudness delta is gated
      // "across overlap, at the mutual target").
      // Half-a-hop of tolerance: when the window EQUALS the fade (the 2 s
      // minimum), only one exact center fits and the 100 ms hop grid may
      // never land on it — without the slack the gate would be unmeasurable.
      const slack = 0.05;
      if (
        t - loudnessWindow / 2 < opts.fadeStartSeconds - slack ||
        t + loudnessWindow / 2 > fadeEnd + slack
      ) {
        continue;
      }
      const delta = Math.abs(lufs - target);
      if (loudnessDeltaLu == null || delta > loudnessDeltaLu) loudnessDeltaLu = delta;
    }
  }

  // After the transition settles: fades settle at fade end; the failure
  // recoveries CUT at the fade-start moment.
  const settledAt = opts.simulateAutomationFailure ? opts.fadeStartSeconds : fadeEnd;
  const postTransition = {
    outgoingToneDb: toneEnergyDb(
      mono,
      sampleRate,
      opts.out.toneHz,
      settledAt + 0.5,
      settledAt + 1.5,
    ),
    incomingToneDb: toneEnergyDb(
      mono,
      sampleRate,
      opts.in.toneHz,
      settledAt + 0.5,
      settledAt + 1.5,
    ),
  };

  return {
    truePeakDb: truePeakDbOf(channels),
    outputGapMs: longestGapMs(mono, sampleRate, opts.fadeStartSeconds - 1, fadeEnd + 1),
    clickMaxStep: maxStepIn(channels, sampleRate, [
      [0, 0.1],
      [opts.fadeStartSeconds - 0.05, fadeEnd + 0.05],
    ]),
    loudnessDeltaLu,
    mutualTargetLufs: target,
    appliedGains: gains,
    fixtureLufs: { out: outLufs, in: inLufs },
    postTransition,
  };
}

// --- Single-track loop seam ------------------------------------------------------

/** A rendered loop seam plus the PRODUCTION schedule it played. */
export interface LoopSeamMetrics extends EdgeMetrics {
  plan: AlignedEdgePlan;
  /** The `loopSeam()` overlap the schedule honored (≤ half the track). */
  overlapSeconds: number;
}

/**
 * Render the repeat-one seam exactly as production schedules it: the SAME
 * track on both decks, the crossfade shortened to `loopSeam()`'s overlap, and
 * the fade/incoming-start moments computed by the REAL `planAlignedEdge` —
 * outgoing tail grid against incoming head grid — not hand-picked times. A
 * regression in the production seam schedule (fade off the tail beat, a lost
 * head-anchor lead) shifts this render and fails the gates.
 */
export async function renderLoopSeam(opts?: {
  crossfadeSeconds?: number;
  track?: SynthTrackSpec;
}): Promise<LoopSeamMetrics> {
  const track: SynthTrackSpec = opts?.track ?? {
    durationSeconds: 20,
    bpm: 120,
    anchorSeconds: 0.25,
    toneHz: 220,
    toneAmplitude: 0.25,
    clickAmplitude: 0.25,
  };
  const grid = { anchorSeconds: track.anchorSeconds, periodSeconds: 60 / track.bpm };
  const { overlapSeconds } = loopSeam(track.durationSeconds, opts?.crossfadeSeconds ?? 4);
  const plan = planAlignedEdge({
    outDurationSeconds: track.durationSeconds,
    outTail: grid,
    inHead: grid,
    crossfadeSeconds: overlapSeconds,
    earliestStartSeconds: 0,
  });
  if (!plan) throw new Error('the production planner refused the seam fixture');
  const metrics = await renderEdge({
    out: track,
    in: track,
    fadeStartSeconds: plan.fadeStartSeconds,
    fadeSeconds: plan.fadeSeconds,
    incomingStartSeconds: plan.fadeStartSeconds - plan.incomingLeadSeconds,
    gains: 'mutual',
  });
  return { ...metrics, plan, overlapSeconds };
}

// --- MP3 decode-offset parity ----------------------------------------------------

/**
 * Decode an audio URL with the browser's `decodeAudioData` and return the first
 * sample at/above `threshold` as seconds — the marker anchor. Compared against
 * the worker's ffmpeg-decoded anchor (the MP3 encoder-delay risk): a
 * constant per-decoder offset would shift every anchor and does NOT cancel
 * across a media↔buffer mixed edge.
 */
export async function decodeAnchorSeconds(url: string, threshold = 0.1): Promise<number | null> {
  const res = await fetch(url);
  const bytes = await res.arrayBuffer();
  // 44.1 kHz context: the fixture's native rate, so no resampling shifts the onset.
  const ctx = new OfflineAudioContext(1, 44_100, 44_100);
  const decoded = await ctx.decodeAudioData(bytes);
  const data = decoded.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    if (Math.abs(data[i] ?? 0) >= threshold) return i / decoded.sampleRate;
  }
  return null;
}
