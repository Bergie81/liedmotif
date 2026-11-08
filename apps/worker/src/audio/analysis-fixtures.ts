// Deterministic audio fixtures for the analysis tests. These are the CI-stable,
// ground-truth calibration slice: synthetic click tracks (constant tempo and ±drift) with exact beat
// times, ambient/weak-onset material the estimator must REFUSE, and a WAV
// writer for the ffmpeg fixture tests. The fixed-seed generators keep the
// thresholds reproducible. Test support only — never imported by runtime code.

import { ESTIMATOR_SAMPLE_RATE } from './estimator';

export interface SynthesizedAudio {
  pcm: Float32Array;
  /** Ground-truth beat times in seconds (empty for beatless material). */
  truth: number[];
}

/**
 * A click track at `bpm`. `driftPct` varies the instantaneous period linearly
 * from (1−d)× to (1+d)× nominal across the duration (the
 * "±0.4% linear drift" fixture uses 0.004).
 */
export function clickTrack(
  bpm: number,
  seconds: number,
  {
    driftPct = 0,
    offset = 0.35,
    clickHz = 1000,
  }: { driftPct?: number; offset?: number; clickHz?: number } = {},
): SynthesizedAudio {
  const pcm = new Float32Array(Math.round(seconds * ESTIMATOR_SAMPLE_RATE));
  const truth: number[] = [];
  let t = offset;
  while (t < seconds - 0.1) {
    truth.push(t);
    const frac = t / seconds;
    const period = (60 / bpm) * (1 + driftPct * (2 * frac - 1));
    const s0 = Math.round(t * ESTIMATOR_SAMPLE_RATE);
    for (let k = 0; k < 128 && s0 + k < pcm.length; k++) {
      // `clickHz` makes tracks BAND-DISTINGUISHABLE for the observed-output
      // measurement (each deck's audible beats attributable in the summed tap).
      pcm[s0 + k]! +=
        Math.sin((2 * Math.PI * clickHz * k) / ESTIMATOR_SAMPLE_RATE) * Math.exp(-k / 24) * 0.8;
    }
    t += period;
  }
  return { pcm, truth };
}

/**
 * A click track whose onsets scatter around the true grid (seeded Gaussian-ish
 * jitter) with varying amplitudes — the "real music" residual profile (matched
 * beats with 10–25 ms scatter) that a fixed residual cutoff wrongly refuses.
 * The TRUE grid stays the un-jittered one: a least-squares fit must average
 * the jitter away, so anchor-error budgets still apply against `truth`.
 */
export function jitteredClickTrack(
  bpm: number,
  seconds: number,
  { jitterMs = 12, seed = 7 }: { jitterMs?: number; seed?: number } = {},
): SynthesizedAudio {
  const rand = seededRand(seed);
  const pcm = new Float32Array(Math.round(seconds * ESTIMATOR_SAMPLE_RATE));
  const truth: number[] = [];
  const period = 60 / bpm;
  for (let t = 0.35; t < seconds - 0.1; t += period) {
    truth.push(t);
    // Sum of two uniforms ≈ triangular: cheap, bounded, seeded jitter.
    const jitter = (rand() + rand()) * (jitterMs / 1000);
    const amp = 0.5 + 0.45 * (rand() + 0.5);
    const s0 = Math.round((t + jitter) * ESTIMATOR_SAMPLE_RATE);
    if (s0 < 0) continue;
    for (let k = 0; k < 128 && s0 + k < pcm.length; k++) {
      pcm[s0 + k]! +=
        Math.sin((2 * Math.PI * 1000 * k) / ESTIMATOR_SAMPLE_RATE) * Math.exp(-k / 24) * amp;
    }
  }
  return { pcm, truth };
}

/**
 * A vocal-MIX fixture: a backing beat (soft kick + hat-like transient on the
 * true grid) under a competing VOCAL layer — soft-attack "syllables" scattered
 * around beats and syncopated off-beats, plus a sustained vibrato "melisma"
 * tone with slow phrasing that smears the onset envelope, the way real sung
 * vocals mask periodicity. Tuned against the production estimator to activate
 * INSIDE the corpus-vocal band (confidence ≈ 0.83, i.e. above the 0.75 floor
 * the way corpus vocals activated at 0.767–0.876) with a genuine ~18 ms anchor
 * error. The TRUE grid stays the clean one, so anchor error against `truth`
 * measures how far the vocal layer pulled the fitted grid.
 */
export function vocalLikeTrack(
  bpm: number,
  seconds: number,
  { seed = 3 }: { seed?: number } = {},
): SynthesizedAudio {
  const rand = seededRand(seed);
  const pcm = new Float32Array(Math.round(seconds * ESTIMATOR_SAMPLE_RATE));
  const truth: number[] = [];
  const period = 60 / bpm;

  // Backing beat on the true grid: what activation legitimately rides on.
  for (let t = 0.35; t < seconds - 0.15; t += period) {
    truth.push(t);
    const s0 = Math.round(t * ESTIMATOR_SAMPLE_RATE);
    for (let k = 0; k < 512 && s0 + k < pcm.length; k++) {
      pcm[s0 + k]! +=
        0.4 * Math.exp(-k / 120) * Math.sin((2 * Math.PI * 85 * k) / ESTIMATOR_SAMPLE_RATE);
    }
    for (let k = 0; k < 96 && s0 + k < pcm.length; k++) {
      pcm[s0 + k]! +=
        0.25 * Math.exp(-k / 20) * Math.sin((2 * Math.PI * 1200 * k) / ESTIMATOR_SAMPLE_RATE);
    }
  }

  // A soft-attack tonal onset (a sung syllable, not a percussive click).
  const syllable = (atSeconds: number, amp: number, freq: number) => {
    const s0 = Math.round(atSeconds * ESTIMATOR_SAMPLE_RATE);
    const attack = Math.round(0.025 * ESTIMATOR_SAMPLE_RATE);
    const total = Math.round(0.15 * ESTIMATOR_SAMPLE_RATE);
    for (let k = 0; k < total && s0 + k >= 0 && s0 + k < pcm.length; k++) {
      const env = k < attack ? k / attack : Math.exp(-(k - attack) / (total / 4));
      pcm[s0 + k]! += amp * env * Math.sin((2 * Math.PI * freq * k) / ESTIMATOR_SAMPLE_RATE);
    }
  };
  for (let t = 0.35; t < seconds - 0.2; t += period) {
    // ~75% of beats carry a syllable, scattered ±20 ms, varying loudness/pitch.
    if (rand() + 0.5 > 0.25) {
      syllable(
        t + (rand() + rand()) * 0.02,
        0.5 * (0.7 + 0.6 * (rand() + 0.5)),
        320 + 280 * (rand() + 0.5),
      );
    }
    // Syncopation: off-beat eighths compete with the grid.
    if (rand() + 0.5 > 0.55) {
      syllable(
        t + period / 2 + (rand() + rand()) * 0.035,
        0.5 * (0.5 + 0.5 * (rand() + 0.5)),
        380 + 240 * (rand() + 0.5),
      );
    }
  }
  // The melisma: sustained vibrato + slow phrasing (breaths) under everything.
  // Vibrato at 7.1 Hz — deliberately OFF the beat-grid harmonics, so the
  // fixture exercises vocal masking without handing the autocorrelation a fake
  // in-window periodicity (a 5.5 Hz vibrato's 3rd envelope harmonic lands at
  // +9% of a 120 BPM beat and hijacks the lag search — measured, not theory).
  for (let i = 0; i < pcm.length; i++) {
    const tSec = i / ESTIMATOR_SAMPLE_RATE;
    const vibrato = 1 + 0.03 * Math.sin(2 * Math.PI * 7.1 * tSec);
    const phrase = 0.55 + 0.45 * Math.sin((2 * Math.PI * tSec) / 3.7);
    pcm[i]! += 0.175 * phrase * Math.sin(2 * Math.PI * 340 * vibrato * tSec);
  }
  return { pcm, truth };
}

/** A fixed-seed LCG, so ambient fixtures are bit-identical run to run. */
function seededRand(seedStart: number): () => number {
  let seed = seedStart;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
}

/**
 * Low-passed noise with a slow amplitude swell — no usable onset periodicity.
 * With `beatBpm`/`beatAmp` set, a faint thump is mixed in (the "weak beat the
 * estimator must still refuse" fixture).
 */
export function ambient(
  seconds: number,
  {
    beatBpm = 0,
    beatAmp = 0,
    seed = 42,
  }: { beatBpm?: number; beatAmp?: number; seed?: number } = {},
): SynthesizedAudio {
  const rand = seededRand(seed);
  const pcm = new Float32Array(Math.round(seconds * ESTIMATOR_SAMPLE_RATE));
  const truth: number[] = [];
  let lp = 0;
  for (let i = 0; i < pcm.length; i++) {
    lp += 0.02 * (rand() * 0.9 - lp);
    pcm[i] = lp * (1 + 0.5 * Math.sin((2 * Math.PI * 0.1 * i) / ESTIMATOR_SAMPLE_RATE)) * 3;
  }
  if (beatBpm > 0) {
    let t = 0.5;
    while (t < seconds - 0.1) {
      truth.push(t);
      const s0 = Math.round(t * ESTIMATOR_SAMPLE_RATE);
      for (let k = 0; k < 96 && s0 + k < pcm.length; k++) {
        pcm[s0 + k]! +=
          Math.sin((2 * Math.PI * 180 * k) / ESTIMATOR_SAMPLE_RATE) * Math.exp(-k / 40) * beatAmp;
      }
      t += 60 / beatBpm;
    }
  }
  return { pcm, truth };
}

/** A pure sine — its integrated loudness and true peak are known analytically
 *  (a 997 Hz sine at amplitude a measures ≈ −3.01 + 20·log10(a) LUFS and
 *  20·log10(a) dBTP), which pins the ffmpeg loudness fixture test. */
export function sineWave(
  frequencyHz: number,
  seconds: number,
  amplitude: number,
  sampleRate: number = ESTIMATOR_SAMPLE_RATE,
): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
  }
  return pcm;
}

/** Distance from `anchorSeconds` to the nearest ground-truth beat, in seconds
 *  (a fitted anchor may legitimately lock onto any beat of the grid). */
export function anchorErrorSeconds(anchorSeconds: number, truth: readonly number[]): number {
  let best = Infinity;
  for (const t of truth) {
    const d = Math.abs(anchorSeconds - t);
    if (d < best) best = d;
  }
  return best;
}

/** Encode mono float PCM as a 16-bit PCM WAV file (for ffmpeg fixture tests). */
export function pcmToWav(pcm: Float32Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]!));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}
