// Bounded `ffmpeg` invocation for track analysis.
//
// ffmpeg is consumed via child-process AGGREGATION only — never linked — for
// licensing reasons; the worker image installs the pinned distro
// package and CI smokes its build configuration (see `docker/ci/`). Every
// invocation is bounded: wall-clock timeout with SIGKILL, stdout `maxBuffer`,
// and stderr captured but SANITIZED before it can reach diagnostics (no env
// values, no URLs — provider URLs and signed links must never leak into logs).
//
// Two passes per staged file:
//   1. `measureLoudness` — loudnorm print_format=json measure-only pass
//      (integrated LUFS + true peak),
//   2. `decodePcmMono` — mono 22.05 kHz f32le PCM on stdout for the tempo
//      estimator.
//
// The subprocess runner is injectable so tests exercise timeout/kill/maxBuffer
// paths with a stub — no real ffmpeg needed (hosts without it skip the
// fixture-backed tests; provenance handles them at runtime via `unavailable`).

import { execFile } from 'node:child_process';
import { ESTIMATOR_SAMPLE_RATE } from './estimator';

/** Per-pass budget (each ffmpeg pass ≤ 60 s). */
export const FFMPEG_PASS_TIMEOUT_MS = 60_000;
/** loudnorm JSON lives in the stderr tail; 1 MiB bounds a runaway stream. */
const LOUDNORM_MAX_BUFFER_BYTES = 1024 * 1024;
/** PCM stdout bound: the 15-min duration guard × 22.05 kHz mono f32 ≈ 80 MB. */
export const PCM_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

export interface FfmpegRunResult {
  stdout: Buffer;
  stderr: string;
}

/** Minimal bounded-subprocess contract (mirrors `execFile` semantics: rejects on
 *  non-zero exit / timeout kill / maxBuffer breach, with any captured output on
 *  the error object). */
export type FfmpegRunner = (
  args: string[],
  bounds: { timeoutMs: number; maxBufferBytes: number },
) => Promise<FfmpegRunResult>;

/** Strip anything URL-shaped and cap length — stderr goes into diagnostics. */
export function sanitizeFfmpegStderr(stderr: string): string {
  return stderr
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .slice(-2000)
    .trim();
}

const FFMPEG_ERROR_LINE = /error|invalid|failed|unable|corrupt|unsupported|denied|no such|missing/i;

/**
 * Distill stderr into an error summary SAFE for logs and `last_error`: raw
 * ffmpeg stderr echoes the input's metadata (titles, album/session names —
 * user-intent-derived values the repo's logging rules protect), so only
 * un-indented, error-shaped lines survive. ffmpeg prints metadata indented
 * under its `Metadata:` banners; diagnostics like `[mp3 @ 0x…] Header missing`
 * start at column 0.
 */
export function extractFfmpegErrorSummary(stderr: string): string {
  const lines = sanitizeFfmpegStderr(stderr)
    .split('\n')
    .filter((line) => !/^\s/.test(line) && FFMPEG_ERROR_LINE.test(line));
  return lines.join(' | ').slice(0, 300);
}

interface ExecFileError extends Error {
  killed?: boolean;
  code?: string | number;
  stdout?: Buffer;
  stderr?: Buffer | string;
}

/** The production runner: `execFile` with kill-on-timeout (SIGKILL fires, no
 *  zombies; Node reaps its own children). */
export const execFileFfmpegRunner: FfmpegRunner = (args, bounds) =>
  new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      {
        timeout: bounds.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: bounds.maxBufferBytes,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = error as ExecFileError;
          // Attach only the distilled error lines; raw stderr echoes input
          // metadata and must never reach logs (see extractFfmpegErrorSummary).
          const reason = wrapped.killed
            ? `ffmpeg killed after ${bounds.timeoutMs}ms`
            : wrapped.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'ffmpeg output exceeded maxBuffer'
              : `ffmpeg exited with ${String(wrapped.code ?? 'unknown')}`;
          reject(new Error(`${reason}: ${extractFfmpegErrorSummary(String(stderr ?? ''))}`));
          return;
        }
        resolve({ stdout, stderr: String(stderr) });
      },
    );
  });

/** Probe for a usable ffmpeg on this host (worker boot + analyzer gate). */
export async function isFfmpegAvailable(
  run: FfmpegRunner = execFileFfmpegRunner,
): Promise<boolean> {
  try {
    await run(['-version'], { timeoutMs: 10_000, maxBufferBytes: LOUDNORM_MAX_BUFFER_BYTES });
    return true;
  } catch {
    return false;
  }
}

export interface LoudnessMeasurement {
  /** BS.1770 integrated loudness of the whole file, LUFS. */
  integratedLufs: number;
  /** True peak, dBTP. */
  truePeakDb: number;
}

/**
 * Parse the JSON block `loudnorm` prints at the tail of stderr. Exported for
 * the captured-output parse tests.
 */
export function parseLoudnormOutput(stderr: string): LoudnessMeasurement {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('loudnorm output contained no JSON block');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('loudnorm JSON block did not parse');
  }
  const integratedLufs = Number(parsed['input_i']);
  const truePeakDb = Number(parsed['input_tp']);
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb)) {
    throw new Error('loudnorm JSON block is missing input_i / input_tp');
  }
  return { integratedLufs, truePeakDb };
}

/** Measure-only loudnorm pass over the staged file (never modifies audio). */
export async function measureLoudness(
  stagedPath: string,
  options: { run?: FfmpegRunner; timeoutMs?: number } = {},
): Promise<LoudnessMeasurement> {
  const run = options.run ?? execFileFfmpegRunner;
  const { stderr } = await run(
    [
      '-hide_banner',
      '-nostats',
      '-i',
      stagedPath,
      '-af',
      'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ],
    {
      timeoutMs: options.timeoutMs ?? FFMPEG_PASS_TIMEOUT_MS,
      maxBufferBytes: LOUDNORM_MAX_BUFFER_BYTES,
    },
  );
  return parseLoudnormOutput(stderr);
}

/** Decode the staged file to mono `ESTIMATOR_SAMPLE_RATE` f32 PCM (estimator input). */
export async function decodePcmMono(
  stagedPath: string,
  options: { run?: FfmpegRunner; timeoutMs?: number } = {},
): Promise<Float32Array> {
  const run = options.run ?? execFileFfmpegRunner;
  const { stdout } = await run(
    [
      '-hide_banner',
      '-nostats',
      '-i',
      stagedPath,
      '-ac',
      '1',
      '-ar',
      String(ESTIMATOR_SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ],
    {
      timeoutMs: options.timeoutMs ?? FFMPEG_PASS_TIMEOUT_MS,
      maxBufferBytes: PCM_MAX_BUFFER_BYTES,
    },
  );
  // The common case: a large concat'd stdout owns its whole, aligned buffer —
  // view it directly instead of copying ~tens of MB. Exclusive ownership also
  // matters because the estimator TRANSFERS the buffer into its worker thread;
  // a view into Node's shared Buffer pool (small outputs) must be copied out.
  if (
    stdout.byteOffset === 0 &&
    stdout.byteLength % 4 === 0 &&
    stdout.buffer.byteLength === stdout.byteLength
  ) {
    return new Float32Array(stdout.buffer);
  }
  // Align to a fresh buffer: Buffer views can start at a nonzero offset, and a
  // truncated trailing sample is dropped.
  const aligned = new Uint8Array(stdout.byteLength - (stdout.byteLength % 4));
  aligned.set(stdout.subarray(0, aligned.byteLength));
  return new Float32Array(aligned.buffer);
}
