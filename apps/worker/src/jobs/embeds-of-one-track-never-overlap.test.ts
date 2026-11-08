// A retag measures the stored tag, then streams the old body from that offset
// into the rewrite, so two retags of one MP3 running at once splice one's new
// tag into the other's audio for good. A REAL Graphile runner proves the two
// enqueue sites (worker follow-ups and the web batch) never let that happen:
// Graphile's `replace` job key alone hands a running job's key to a fresh,
// immediately runnable job.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run, type Runner } from 'graphile-worker';
import { addWorkerJobBatch, TRACK_EMBED_QUEUE_NAME } from '@liedmotif/db';
import { connectTestDb, TEST_DATABASE_URL, type TestDb } from '@liedmotif/db/testing';
import { enqueueEmbedTrackMetadata } from './enqueue';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('embed-track-metadata scheduling', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-embed-overlap-test');
    // A fresh graphile_worker schema: leftover jobs from other suites would
    // otherwise land in this runner with unknown task identifiers.
    await ctx.pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });

  it('never runs a second embed of a track while the first is still rewriting it', async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    let release: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => (release = resolve));
    let markStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => (markStarted = resolve));

    let runner: Runner | undefined;
    try {
      runner = await run({
        pgPool: ctx.pool,
        concurrency: 2,
        pollInterval: 50,
        noHandleSignals: true,
        taskList: {
          'embed-track-metadata': async () => {
            running++;
            runs++;
            maxRunning = Math.max(maxRunning, running);
            markStarted?.();
            await firstHeld;
            running--;
          },
        },
      });

      await enqueueEmbedTrackMetadata(runner.addJob, 'track-1');
      await firstStarted;
      // The web side's re-enqueue for the same track (e.g. a Session rename)
      // while the first rewrite is mid-flight, with a free runner slot.
      await addWorkerJobBatch(
        ctx.db,
        'embed-track-metadata',
        [{ payload: { trackId: 'track-1' }, jobKey: 'embed:track-1' }],
        TRACK_EMBED_QUEUE_NAME,
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(maxRunning).toBe(1);

      release?.();
      const deadline = Date.now() + 10_000;
      while (runs < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // The re-enqueue still runs once the first rewrite finishes.
      expect(runs).toBe(2);
      expect(maxRunning).toBe(1);
    } finally {
      release?.();
      await runner?.stop();
    }
  }, 30_000);
});
