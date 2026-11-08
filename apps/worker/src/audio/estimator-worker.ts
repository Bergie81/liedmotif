// worker_threads entry for the anchored tempo estimator: the autocorrelation
// is CPU-heavy, and a serialized Graphile queue alone still blocks the shared
// Node event loop — which would delay provider polling past its SLO. This file
// runs the pure DSP off the main thread; spawn it via `runEstimatorInThread`
// (estimator-thread.ts), never directly.
//
// Built as its OWN tsup entry (`dist/estimator-worker.js`, self-contained); in
// dev/tests Node 24 loads this .ts source directly via native type stripping,
// which is why the relative import carries an explicit `.ts` extension.

import { parentPort, workerData } from 'node:worker_threads';
import { estimateAnchoredTempo } from './estimator.ts';

const { pcm, targetBpm } = workerData as { pcm: Float32Array; targetBpm: number };
parentPort?.postMessage(estimateAnchoredTempo(pcm, targetBpm));
