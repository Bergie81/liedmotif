import { describe, expect, it, vi } from 'vitest';
import { CURRENT_ANALYSIS_VERSION } from '@liedmotif/shared';
import type { AddJobFunction } from 'graphile-worker';
import {
  enqueueAnalyzeTrack,
  enqueueBufferRefill,
  enqueueDownloadFinalAudio,
  enqueuePollAt,
  enqueuePollPreservingSchedule,
  enqueueProcessProviderResults,
} from './enqueue';

// The dedup jobKeys + jobKeyMode ARE the pipeline's concurrency contract; pin them here
// so a refactor can't silently change a key/mode and break dedup or recovery.
describe('pipeline enqueue helpers', () => {
  function spy() {
    return vi.fn(async () => ({})) as unknown as AddJobFunction;
  }

  it('downloads with a stable per-track jobKey', async () => {
    const addJob = spy();
    await enqueueDownloadFinalAudio(addJob, 't1');
    expect(addJob).toHaveBeenCalledWith(
      'download-final-audio',
      { trackId: 't1' },
      { jobKey: 'download:t1' },
    );
  });

  it('refills the buffer per session, leaving an already-queued refill alone', async () => {
    const addJob = spy();
    await enqueueBufferRefill(addJob, 's1');
    expect(addJob).toHaveBeenCalledWith(
      'ensure-session-buffer',
      { sessionId: 's1' },
      // Dedupe (not replace/preserve_run_at): the every-minute sweep issues this
      // same enqueue, and both other modes reset a failing refill's attempts.
      { jobKey: 'buffer:s1', jobKeyMode: 'unsafe_dedupe' },
    );
  });

  it('queues analysis versioned, serialized, and retry-bounded', async () => {
    const addJob = spy();
    // The shipped `maxRetriesPerJob` default.
    await enqueueAnalyzeTrack(addJob, 't1', 2);
    expect(addJob).toHaveBeenCalledWith(
      'analyze-track-bpm-key',
      { trackId: 't1' },
      {
        // Versioned: a reanalysis for a NEW analyzer version never collides
        // with (or resets) a pending job keyed for the old one.
        jobKey: `analyze:v${CURRENT_ANALYSIS_VERSION}:t1`,
        // Dedupe (not replace): the recurring backfill re-issues this enqueue
        // while a job is pending/retrying — replace would zero the retry state.
        jobKeyMode: 'unsafe_dedupe',
        // Serialized: at most one CPU-heavy analysis at a time.
        queueName: 'track-analysis',
        // Thresholds table governs retries — not Graphile's default 25.
        maxAttempts: 3,
      },
    );
  });

  it('reads the admin cap as RETRIES, and never lets it loosen the thresholds bound', async () => {
    async function expectAttempts(maxRetriesPerJob: number, maxAttempts: number) {
      const addJob = spy();
      await enqueueAnalyzeTrack(addJob, 't1', maxRetriesPerJob);
      expect(addJob).toHaveBeenCalledWith(
        'analyze-track-bpm-key',
        { trackId: 't1' },
        expect.objectContaining({ maxAttempts }),
      );
    }
    await expectAttempts(1, 2);
    await expectAttempts(0, 1); // one attempt always runs
    await expectAttempts(50, 3); // the job's own bound still wins
  });

  it('seeds the materialization recovery without resetting an existing run (unsafe_dedupe)', async () => {
    const addJob = spy();
    await enqueueProcessProviderResults(addJob, 'j1');
    // `unsafe_dedupe` is load-bearing: the every-minute safety-net re-enqueue must not
    // zero a retrying recovery's attempts/run_at (default `replace` would), or a
    // failing recovery loses its exponential backoff and hammers once a minute.
    expect(addJob).toHaveBeenCalledWith(
      'process-provider-results',
      { providerJobId: 'j1' },
      { jobKey: 'process:j1', jobKeyMode: 'unsafe_dedupe' },
    );
  });

  it('schedules a poll at a specific time, keyed per job', async () => {
    const addJob = spy();
    const runAt = new Date('2026-07-01T00:00:25Z');
    await enqueuePollAt(addJob, 'j1', runAt);
    expect(addJob).toHaveBeenCalledWith(
      'poll-music-generation',
      { providerJobId: 'j1' },
      { jobKey: 'poll:j1', runAt },
    );
  });

  it('ensures a poll without disturbing an existing schedule', async () => {
    const addJob = spy();
    await enqueuePollPreservingSchedule(addJob, 'j1');
    expect(addJob).toHaveBeenCalledWith(
      'poll-music-generation',
      { providerJobId: 'j1' },
      { jobKey: 'poll:j1', jobKeyMode: 'unsafe_dedupe' },
    );
  });
});
