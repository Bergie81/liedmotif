// In-house anchored tempo estimator.
//
// Liedmotif generates tracks at a KNOWN target BPM, so this is a residual-drift
// measurer, not a general tempo tracker: spectral-flux onset envelope →
// autocorrelation constrained to ±10% around the request's target BPM → two
// LOCAL weighted least-squares beat-grid fits (head and tail — a single global
// BPM + head anchor cannot bound tail phase error under local drift). Both grids
// ship as an anchor PLUS a locally fitted period; the confidence combines
// autocorrelation salience with both grids' fit quality, and material without
// usable onset periodicity (dense vocals, ambient) refuses cleanly below the
// floor instead of guessing.
//
// The numeric shape (window sizes, comb search, grid fitting) is held to fixed
// accuracy thresholds. The confidence formula was calibrated on real generated
// finals:
//
//   - the grid-residual tolerance is a FRACTION OF THE BEAT PERIOD instead of
//     the prototype's fixed 3 envelope frames (~17 ms). The fixed cutoff
//     implicitly assumed the 160-BPM corpus-v1 class (3 frames ≈ 4.6% of that
//     beat period) and zeroed out honest locks at slower tempi — real
//     four-on-the-floor finals at 126 BPM fit residuals of 13–25 ms with
//     matched fractions ≈ 1.0 and high contrast, which are solid grids.
//   - autocorrelation salience maps the measured separation between material
//     classes (clicks 0.85–0.98, locked real music 0.55–0.67, ambient noise
//     ≈ 0.28, no periodicity ≤ 0.06) onto [0, 1], where the prototype's
//     `min(1, 4·peakR)` saturated even ambient noise to full salience.
//
//   (Superflux/multi-band onset features — the candidate improvement — were
//   measured against this calibration on the same finals and brought no
//   improvement; the plain spectral flux stays.)
//
// Pure CPU-bound math on a `Float32Array` — no I/O — so callers run it off the
// event loop via `runEstimatorInThread` (`estimator-thread.ts`).

/** The PCM sample rate the analysis pipeline decodes to (mono). */
export const ESTIMATOR_SAMPLE_RATE = 22050;

const WIN = 512;
const HOP = 128;
/** Onset-envelope frames per second. */
const FPS = ESTIMATOR_SAMPLE_RATE / HOP;
/** Length of each local grid-fit window (head and tail), in seconds. */
const WINDOW_SECONDS = 30;
/** The autocorrelation lag search half-width around the target period. */
const BPM_SEARCH_FRACTION = 0.1;
/** Grid residual is forgiven up to this fraction of the beat period (see the
 *  header: period-relative, not absolute — a 20 ms scatter is noise at 126 BPM
 *  and a broken grid at 220). */
const RESIDUAL_TOLERANCE_PERIOD_FRACTION = 0.15;
/** Salience mapping: normalized autocorrelation ≤ `SALIENCE_FLOOR` counts as
 *  no periodicity; `SALIENCE_FLOOR + SALIENCE_SPAN` and above as full salience
 *  (calibrated on the measured class separation — see the header). */
const SALIENCE_FLOOR = 0.2;
const SALIENCE_SPAN = 0.45;

/** One locally fitted beat grid: an anchor plus its own fitted period. */
export interface BeatGridFit {
  /** Absolute time of the fitted grid's first beat, in seconds from track start. */
  anchorSeconds: number;
  /** The LOCALLY fitted beat period (may drift from 60/bpm). */
  periodSeconds: number;
  /** Fraction of expected grid points matched to an onset peak. */
  matchedFraction: number;
  /** Mean onset strength at matched beats over the envelope mean. */
  contrast: number;
  /** RMS residual of matched beats around the fitted line, in envelope frames. */
  residualFrames: number;
}

/** The estimator's raw output (provenance decisions belong to the analyzer). */
export interface AnchoredTempoEstimate {
  /** Global BPM from the constrained autocorrelation peak (parabolic-refined). */
  bpm: number;
  /** Combined salience × grid-fit confidence in [0, 1]. */
  confidence: number;
  /** RAW normalized autocorrelation at the peak lag — periodicity strength
   *  before any grid-fit weighting. Diagnostics + the calibration corpus
   *  runner's conformance scan (which must not read `confidence`, or the
   *  activation denominator would be defined by the thing being measured). */
  autocorrelationPeak: number;
  head: BeatGridFit | null;
  tail: BeatGridFit | null;
}

/**
 * Radix-2 FFT magnitude spectrum of one real windowed frame, computed INTO
 * caller-owned scratch arrays (`re`/`im` sized `frame.length`, `mag` sized
 * `frame.length / 2`). Per-frame allocation here would churn ~hundreds of MB
 * of short-lived garbage over a full track's envelope pass.
 */
function fftMagInto(
  frame: Float64Array,
  re: Float64Array,
  im: Float64Array,
  mag: Float64Array,
): void {
  const n = frame.length;
  re.set(frame);
  im.fill(0);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cwr - im[i + k + len / 2]! * cwi;
        const vi = re[i + k + len / 2]! * cwi + im[i + k + len / 2]! * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  // sqrt(a²+b²) over Math.hypot: audio magnitudes never approach the
  // overflow/underflow ranges hypot guards, and hypot is several times slower
  // across the ~8M calls a 3-minute track makes here.
  for (let i = 0; i < n / 2; i++) {
    mag[i] = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!);
  }
}

const HANN = Float64Array.from(
  { length: WIN },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN),
);

/** Log-magnitude spectral-flux onset envelope, locally mean-subtracted. */
function onsetEnvelope(pcm: Float32Array): Float64Array {
  const frames = Math.floor((pcm.length - WIN) / HOP);
  if (frames <= 0) return new Float64Array(0);
  const env = new Float64Array(frames);
  // All FFT scratch is allocated once per envelope pass and reused per frame;
  // the two magnitude buffers ping-pong so `prev` survives the next frame.
  const buf = new Float64Array(WIN);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const magA = new Float64Array(WIN / 2);
  const magB = new Float64Array(WIN / 2);
  let prev: Float64Array | null = null;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < WIN; i++) buf[i] = pcm[f * HOP + i]! * HANN[i]!;
    const mag: Float64Array = prev === magA ? magB : magA;
    fftMagInto(buf, re, im, mag);
    if (prev) {
      let flux = 0;
      for (let i = 1; i < mag.length; i++) {
        const d = Math.log1p(mag[i]!) - Math.log1p(prev[i]!);
        if (d > 0) flux += d;
      }
      env[f] = flux;
    }
    prev = mag;
  }
  // Remove the local mean (adaptive threshold) and half-wave rectify.
  const out = new Float64Array(frames);
  const R = Math.round(FPS * 0.5);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, f - R); k < Math.min(frames, f + R); k++) {
      s += env[k]!;
      c++;
    }
    out[f] = Math.max(0, env[f]! - s / c);
  }
  return out;
}

/** Normalized autocorrelation of the envelope over an inclusive lag window. */
function autocorr(env: Float64Array, lagMin: number, lagMax: number): Map<number, number> {
  const n = env.length;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let denom = 0;
  for (const v of env) denom += (v - mean) ** 2;
  const r = new Map<number, number>();
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i]! - mean) * (env[i + lag]! - mean);
    r.set(lag, denom > 0 ? s / denom : 0);
  }
  return r;
}

/** Sub-sample peak refinement from three neighboring values. */
function parabolic(y0: number, y1: number, y2: number): number {
  const d = y0 - 2 * y1 + y2;
  return d === 0 ? 0 : (0.5 * (y0 - y2)) / d;
}

/**
 * Fit one local beat grid on `env[startFrame, endFrame)`: comb phase search at
 * the given period, onset-peak matching near each grid point (parabolic-refined),
 * then a weighted least-squares line through the matched beats.
 */
function fitGrid(
  env: Float64Array,
  startFrame: number,
  endFrame: number,
  periodFrames: number,
): BeatGridFit | null {
  const seg = env.subarray(startFrame, endFrame);
  const n = seg.length;
  let bestPhase = 0;
  let bestScore = -1;
  for (let ph = 0; ph < periodFrames; ph += 0.25) {
    let s = 0;
    let c = 0;
    for (let t = ph; t < n - 1; t += periodFrames) {
      const i = Math.floor(t);
      const fr = t - i;
      s += seg[i]! * (1 - fr) + seg[i + 1]! * fr;
      c++;
    }
    if (c > 0 && s / c > bestScore) {
      bestScore = s / c;
      bestPhase = ph;
    }
  }
  const tol = periodFrames * 0.15;
  const beats: Array<{ k: number; t: number; v: number }> = [];
  for (let k = 0, t = bestPhase; t < n - 2; k++, t = bestPhase + k * periodFrames) {
    let pi = -1;
    let pv = -1;
    for (let i = Math.max(1, Math.floor(t - tol)); i <= Math.min(n - 2, Math.ceil(t + tol)); i++) {
      if (seg[i]! >= seg[i - 1]! && seg[i]! >= seg[i + 1]! && seg[i]! > pv) {
        pv = seg[i]!;
        pi = i;
      }
    }
    if (pi >= 1 && pv > 0) {
      beats.push({ k, t: pi + parabolic(seg[pi - 1]!, seg[pi]!, seg[pi + 1]!), v: pv });
    }
  }
  const expected = Math.floor((n - bestPhase) / periodFrames);
  if (beats.length < 4 || expected < 4) return null;
  // Weighted least squares t = intercept + slope * k.
  let sw = 0;
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  for (const b of beats) {
    const w = b.v;
    sw += w;
    sk += w * b.k;
    st += w * b.t;
    skk += w * b.k * b.k;
    skt += w * b.k * b.t;
  }
  const det = sw * skk - sk * sk;
  if (det === 0) return null;
  const slope = (sw * skt - sk * st) / det;
  const intercept = (skk * st - sk * skt) / det;
  let envMean = 0;
  for (const v of seg) envMean += v;
  envMean /= n;
  let beatMean = 0;
  for (const b of beats) beatMean += b.v;
  beatMean /= beats.length;
  let res = 0;
  for (const b of beats) res += (b.t - (intercept + slope * b.k)) ** 2;
  res = Math.sqrt(res / beats.length);
  return {
    anchorSeconds: ((startFrame + intercept) * HOP) / ESTIMATOR_SAMPLE_RATE,
    periodSeconds: (slope * HOP) / ESTIMATOR_SAMPLE_RATE,
    matchedFraction: beats.length / expected,
    contrast: beatMean / (envMean + 1e-12),
    residualFrames: res,
  };
}

/**
 * Estimate the residual tempo drift of `pcm` (mono, `ESTIMATOR_SAMPLE_RATE`)
 * around the generation-time `targetBpm`. Callers gate on `confidence` (the
 * shared `BPM_CONFIDENCE_FLOOR`); a refusal is a low confidence, never a throw.
 */
export function estimateAnchoredTempo(pcm: Float32Array, targetBpm: number): AnchoredTempoEstimate {
  const env = onsetEnvelope(pcm);
  const targetLag = (60 / targetBpm) * FPS;
  const lagMin = Math.max(4, Math.floor(targetLag * (1 - BPM_SEARCH_FRACTION)));
  const lagMax = Math.ceil(targetLag * (1 + BPM_SEARCH_FRACTION));
  if (env.length <= lagMax + 1) {
    return { bpm: targetBpm, confidence: 0, autocorrelationPeak: 0, head: null, tail: null };
  }
  const r = autocorr(env, lagMin, lagMax);
  let peakLag = lagMin;
  let peakR = -Infinity;
  for (const [lag, v] of r) {
    if (v > peakR) {
      peakR = v;
      peakLag = lag;
    }
  }
  const rm1 = r.get(peakLag - 1);
  const rp1 = r.get(peakLag + 1);
  const refinedLag =
    rm1 !== undefined && rp1 !== undefined ? peakLag + parabolic(rm1, peakR, rp1) : peakLag;
  const bpm = (60 * FPS) / refinedLag;

  const winFrames = Math.min(env.length, Math.round(WINDOW_SECONDS * FPS));
  const head = fitGrid(env, 0, winFrames, refinedLag);
  const tail = fitGrid(env, env.length - winFrames, env.length, refinedLag);

  // Confidence: autocorrelation salience × mean grid-fit quality (both windows).
  const salience = Math.max(0, Math.min(1, (peakR - SALIENCE_FLOOR) / SALIENCE_SPAN));
  const residualToleranceFrames = refinedLag * RESIDUAL_TOLERANCE_PERIOD_FRACTION;
  const fitQ = (g: BeatGridFit | null): number =>
    g
      ? Math.min(1, g.matchedFraction) *
        Math.min(1, g.contrast / 6) *
        Math.max(0, 1 - g.residualFrames / residualToleranceFrames)
      : 0;
  const confidence = Math.min(1, Math.sqrt(salience * ((fitQ(head) + fitQ(tail)) / 2)));

  return { bpm, confidence, autocorrelationPeak: peakR, head, tail };
}
