// The bounded ffmpeg wrapper. Two layers of tests:
//   - stub-runner tests (always run): argument shape, loudnorm JSON parsing,
//     timeout / maxBuffer / exit-code mapping, stderr sanitization;
//   - fixture tests against REAL ffmpeg (skipped when the host has none): a
//     sine WAV whose integrated loudness and true peak are known analytically.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pcmToWav, sineWave } from './analysis-fixtures';
import {
  decodePcmMono,
  execFileFfmpegRunner,
  extractFfmpegErrorSummary,
  isFfmpegAvailable,
  measureLoudness,
  parseLoudnormOutput,
  sanitizeFfmpegStderr,
  type FfmpegRunner,
} from './ffmpeg';

const CAPTURED_LOUDNORM_STDERR = `size=N/A time=00:04:55.06 bitrate=N/A speed=71.7x
[Parsed_loudnorm_0 @ 0x5599d1b8c800]
{
	"input_i" : "-12.85",
	"input_tp" : "-1.12",
	"input_lra" : "5.80",
	"input_thresh" : "-23.11",
	"output_i" : "-14.10",
	"output_tp" : "-1.50",
	"output_lra" : "5.10",
	"output_thresh" : "-24.34",
	"normalization_type" : "dynamic",
	"target_offset" : "0.10"
}
`;

describe('parseLoudnormOutput', () => {
  it('parses integrated LUFS and true peak from the stderr tail', () => {
    const result = parseLoudnormOutput(CAPTURED_LOUDNORM_STDERR);
    expect(result.integratedLufs).toBeCloseTo(-12.85, 5);
    expect(result.truePeakDb).toBeCloseTo(-1.12, 5);
  });

  it('throws on output with no JSON block', () => {
    expect(() => parseLoudnormOutput('frame= 100 fps=25')).toThrow(/no JSON block/);
  });

  it('throws when the JSON block lacks the measurements', () => {
    expect(() => parseLoudnormOutput('{"output_i": "-14"}')).toThrow(/input_i/);
  });
});

describe('sanitizeFfmpegStderr', () => {
  it('strips URLs so provider links can never leak into diagnostics', () => {
    const dirty = 'Input #0, mp3, from https://cdn.example.com/signed?token=SECRET failed';
    const clean = sanitizeFfmpegStderr(dirty);
    expect(clean).not.toContain('SECRET');
    expect(clean).not.toContain('cdn.example.com');
    expect(clean).toContain('[url]');
  });

  it('caps the length to a diagnostic tail', () => {
    expect(sanitizeFfmpegStderr('x'.repeat(10_000)).length).toBeLessThanOrEqual(2000);
  });
});

describe('extractFfmpegErrorSummary', () => {
  it('drops input metadata (user-intent-derived titles) but keeps the error lines', () => {
    // The shape ffmpeg prints on a failed decode: banner + indented metadata
    // (which can carry session names / prompt-like values) + diagnostics.
    const stderr = [
      "Input #0, mp3, from '/tmp/liedmotif-analysis-x/input':",
      '  Metadata:',
      '    title           : Secret Session About My Breakup',
      '    album           : Very Private Vibes',
      '    Liedmotif        : v1?abc?Secret Session About My Breakup',
      '[mp3float @ 0x55] Header missing',
      'Error while decoding stream #0:0: Invalid data found when processing input',
    ].join('\n');
    const summary = extractFfmpegErrorSummary(stderr);
    expect(summary).not.toContain('Secret');
    expect(summary).not.toContain('Private');
    expect(summary).toContain('Header missing');
    expect(summary).toContain('Invalid data');
    expect(summary.length).toBeLessThanOrEqual(300);
  });
});

describe('bounded runner error mapping (stubbed subprocess)', () => {
  it('maps a timeout kill to a bounded error', async () => {
    const run: FfmpegRunner = () =>
      Promise.reject(new Error('ffmpeg killed after 5ms: [url] partial output'));
    await expect(measureLoudness('/tmp/x', { run })).rejects.toThrow(/killed after/);
  });

  it('propagates a maxBuffer breach as a bounded error', async () => {
    const run: FfmpegRunner = () => Promise.reject(new Error('ffmpeg output exceeded maxBuffer'));
    await expect(decodePcmMono('/tmp/x', { run })).rejects.toThrow(/maxBuffer/);
  });

  it('passes bounded options through to the runner', async () => {
    const calls: Array<{ args: string[]; timeoutMs: number; maxBufferBytes: number }> = [];
    const run: FfmpegRunner = (args, bounds) => {
      calls.push({ args, ...bounds });
      return Promise.resolve({ stdout: Buffer.alloc(8), stderr: CAPTURED_LOUDNORM_STDERR });
    };
    await measureLoudness('/staged/input', { run, timeoutMs: 1234 });
    await decodePcmMono('/staged/input', { run, timeoutMs: 4321 });

    expect(calls[0]!.args).toContain('/staged/input');
    expect(calls[0]!.args.join(' ')).toContain('loudnorm');
    expect(calls[0]!.timeoutMs).toBe(1234);
    expect(calls[1]!.args.join(' ')).toContain('f32le');
    expect(calls[1]!.timeoutMs).toBe(4321);
    // The PCM pass needs the big buffer; loudnorm only reads a stderr tail.
    expect(calls[1]!.maxBufferBytes).toBeGreaterThan(calls[0]!.maxBufferBytes);
  });

  it('decodePcmMono reinterprets stdout bytes as f32 samples', async () => {
    const samples = new Float32Array([0.5, -0.25, 0.125]);
    const run: FfmpegRunner = () =>
      Promise.resolve({ stdout: Buffer.from(samples.buffer.slice(0)), stderr: '' });
    const pcm = await decodePcmMono('/tmp/x', { run });
    expect(Array.from(pcm)).toEqual([0.5, -0.25, 0.125]);
  });
});

// ---- Real-ffmpeg fixture tests (skipped on hosts without ffmpeg) -------------

const ffmpegPresent = await isFfmpegAvailable();

describe.skipIf(!ffmpegPresent)('against real ffmpeg', () => {
  let dir: string;
  let wavPath: string;
  // 997 Hz sine at amplitude 0.25: integrated ≈ −3.01 + 20·log10(0.25) ≈ −15.05
  // LUFS (K-weighting is ~0 dB at 1 kHz), true peak ≈ −12.04 dBTP.
  const amplitude = 0.25;
  const seconds = 5;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'liedmotif-ffmpeg-test-'));
    wavPath = join(dir, 'sine.wav');
    await writeFile(wavPath, pcmToWav(sineWave(997, seconds, amplitude, 44100), 44100));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('measures the known loudness of a sine fixture', async () => {
    const { integratedLufs, truePeakDb } = await measureLoudness(wavPath);
    expect(integratedLufs).toBeGreaterThan(-16.1);
    expect(integratedLufs).toBeLessThan(-14.0);
    expect(truePeakDb).toBeGreaterThan(-12.6);
    expect(truePeakDb).toBeLessThan(-11.5);
  });

  it('decodes to mono estimator-rate PCM of the expected length', async () => {
    const pcm = await decodePcmMono(wavPath);
    expect(Math.abs(pcm.length - seconds * 22050)).toBeLessThan(2205); // ±100 ms
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.3);
  });

  it('a real run through the execFile runner is killed on timeout', async () => {
    await expect(
      // `-re` paces the input at real time, so the 600s run outlasts the
      // timeout on any host; without it a fast machine finishes in ~0.2s.
      execFileFfmpegRunner(
        ['-hide_banner', '-re', '-f', 'lavfi', '-i', 'sine=d=600', '-f', 'null', '-'],
        {
          timeoutMs: 200,
          maxBufferBytes: 1024 * 1024,
        },
      ),
    ).rejects.toThrow(/killed after/);
  });
});
