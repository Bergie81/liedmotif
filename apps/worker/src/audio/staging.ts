// Staging for track analysis: stream the `local_original` asset out of the
// storage abstraction into a private temp file that ffmpeg can seek. Bounded
// like everything in this pipeline: a size guard BEFORE any bytes move, a
// temp-disk headroom check, and a wall-clock timeout on the copy (staging ≤ 30
// s). The caller owns the returned `cleanup` and must run it in `finally` — a
// crashed analysis must never strand multi-MB temp files.

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { StorageProvider } from '@liedmotif/storage';
import { AnalysisInputError, AnalysisResourceError } from './errors';

/** Thresholds table: staging ≤ 30 s. */
export const STAGING_TIMEOUT_MS = 30_000;
/** Input guard: refuse implausibly large finals (≤ 200 MB). */
export const MAX_ANALYSIS_INPUT_BYTES = 200 * 1024 * 1024;
/** Refuse to stage when tmp free space is below input size + this margin. */
const HEADROOM_MARGIN_BYTES = 64 * 1024 * 1024;

export interface StagedAudio {
  path: string;
  /** Removes the temp directory; safe to call more than once. */
  cleanup: () => Promise<void>;
}

export interface StageAnalysisAudioOptions {
  timeoutMs?: number;
  /** Injectable for the headroom tests. */
  freeBytes?: (dir: string) => Promise<number>;
  tempRoot?: string;
}

async function tmpFreeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

/** OS errno values that mean "the host is out of a resource", not "bad input"
 *  or "broken code": full/quota'd disk, exhausted inodes, no free descriptors. */
const RESOURCE_ERRNO = new Set(['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE']);

/**
 * Re-shape a low-level staging error for logs and `last_error`: resource
 * errno → `AnalysisResourceError`; everything else keeps only the errno/name.
 * Raw fs/storage errors embed absolute paths and storage keys, and keys carry
 * Session/Track title slugs — user-intent-derived values the repo's logging
 * rules keep out of logs.
 */
function sanitizedStagingError(step: string, err: unknown): Error {
  // Our own guard errors are already sanitized and carry classification.
  if (err instanceof AnalysisInputError || err instanceof AnalysisResourceError) return err;
  const code = (err as NodeJS.ErrnoException).code ?? (err as Error).name ?? 'unknown';
  if (RESOURCE_ERRNO.has(code)) {
    return new AnalysisResourceError(
      `analysis staging ${step} hit a host resource limit (${code})`,
    );
  }
  return new Error(`analysis staging ${step} failed (${code})`);
}

/**
 * Stage one stored object to a temp file. Throws `AnalysisInputError` for an
 * input that will never fit (permanent → `failed`), `AnalysisResourceError`
 * when the HOST can't take it right now (retried → `unavailable`), and
 * sanitized plain errors on other I/O trouble (transient — Graphile retries).
 * Error messages never carry storage keys or filesystem paths (see
 * `sanitizedStagingError`).
 */
export async function stageAnalysisAudio(
  storage: StorageProvider,
  storageKey: string,
  options: StageAnalysisAudioOptions = {},
): Promise<StagedAudio> {
  let stat;
  try {
    stat = await storage.stat(storageKey);
  } catch (err) {
    throw sanitizedStagingError('stat', err);
  }
  if (!stat) throw new Error('analysis input missing from storage');
  if (stat.byteSize > MAX_ANALYSIS_INPUT_BYTES) {
    throw new AnalysisInputError(
      `analysis input too large: ${stat.byteSize} bytes (max ${MAX_ANALYSIS_INPUT_BYTES})`,
    );
  }

  const tempRoot = options.tempRoot ?? tmpdir();
  let free: number;
  try {
    free = await (options.freeBytes ?? tmpFreeBytes)(tempRoot);
  } catch (err) {
    // statfs itself can hit resource exhaustion (EMFILE) — classify it too.
    throw sanitizedStagingError('statfs', err);
  }
  if (free < stat.byteSize + HEADROOM_MARGIN_BYTES) {
    // A host condition, not an input defect: retried, and after the retries
    // run out the job records `unavailable` (reopened by the boot probe once
    // the host recovers) — never a permanent `failed`.
    throw new AnalysisResourceError(
      `not enough temp-disk headroom to stage analysis input (${free} bytes free)`,
    );
  }

  let dir: string;
  try {
    dir = await mkdtemp(join(tempRoot, 'liedmotif-analysis-'));
  } catch (err) {
    throw sanitizedStagingError('mkdtemp', err);
  }
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };
  try {
    // The extension is irrelevant to ffmpeg (it sniffs the container).
    const path = join(dir, 'input');
    // ONE timeout owns acquisition AND copy: staging must settle (and clean
    // its own temp dir) even when `readStream()` itself never does — the
    // caller's deadline race cannot reach a cleanup handle that was never
    // returned. A stream that arrives after the timeout is destroyed on
    // arrival so its descriptor doesn't dangle.
    const signal = AbortSignal.timeout(options.timeoutMs ?? STAGING_TIMEOUT_MS);
    const pendingRead = storage.readStream(storageKey);
    const source = await Promise.race([
      pendingRead,
      new Promise<never>((_, timedOut) => {
        signal.addEventListener(
          'abort',
          () => {
            void pendingRead.then((late) => late.destroy()).catch(() => {});
            const timeout = new Error('analysis staging read timed out');
            timeout.name = 'StagingReadTimeout';
            timedOut(timeout);
          },
          { once: true },
        );
      }),
    ]);
    await pipeline(source, createWriteStream(path), { signal });
    return { path, cleanup };
  } catch (err) {
    await cleanup();
    throw sanitizedStagingError('copy', err);
  }
}
