// Spawn API for the estimator worker thread.
// One thread per analysis job — the analysis queue is serialized, so at most one
// estimator thread exists at a time; the cost of thread startup (~ms) is noise
// against the multi-second DSP it moves off the event loop.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AnchoredTempoEstimate } from './estimator';

/** Generous per-track bound; the analyzer's overall job deadline is the real gate. */
export const DEFAULT_ESTIMATOR_TIMEOUT_MS = 60_000;

/**
 * In the bundled worker image the thread entry is the sibling tsup output
 * `dist/estimator-worker.js`; from source (dev `tsx`, Vitest) that file does not
 * exist and Node 24 runs the `.ts` entry directly via native type stripping.
 */
function resolveWorkerEntry(): URL {
  const bundled = new URL('./estimator-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(bundled))) return bundled;
  return new URL('./estimator-worker.ts', import.meta.url);
}

/**
 * Run `estimateAnchoredTempo` in a worker thread. The PCM buffer is
 * TRANSFERRED, not cloned — the caller hands the array over and must not touch
 * it afterwards (its view detaches). Cloning would hold a second full copy of
 * up to ~80 MB of PCM live across the multi-second DSP. Rejects — and
 * terminates the thread — on timeout, thread error, or an exit without a
 * result.
 */
export function runEstimatorInThread(
  pcm: Float32Array,
  targetBpm: number,
  options: { timeoutMs?: number } = {},
): Promise<AnchoredTempoEstimate> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ESTIMATOR_TIMEOUT_MS;
  return new Promise<AnchoredTempoEstimate>((resolve, reject) => {
    const worker = new Worker(resolveWorkerEntry(), {
      workerData: { pcm, targetBpm },
      transferList: [pcm.buffer as ArrayBuffer],
    });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`tempo estimator timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref();
    worker.once('message', (result: AnchoredTempoEstimate) => settle(() => resolve(result)));
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code) => {
      settle(() => reject(new Error(`tempo estimator thread exited without a result (${code})`)));
    });
  });
}
