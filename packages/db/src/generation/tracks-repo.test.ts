import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_ANALYSIS_VERSION, deriveTrackRetentionClass } from '@liedmotif/shared';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  rawTrackRow,
} from './test-fixtures';
import {
  countTracksByAnalysisStatus,
  getTrackForAnalysis,
  insertGeneratedTrack,
  listTracksNeedingAnalysis,
  resetUnavailableTrackAnalyses,
  writeTrackAnalysis,
} from './tracks-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('tracks repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-tracks-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function seedChain(opts: { requestTargetBpm?: number | null } = {}): Promise<{
    ownerUserId: string;
    requestId: string;
    jobId: string;
    sessionId: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental lofi', bpm: 96, key: 'D minor' },
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      targetBpm: opts.requestTargetBpm === undefined ? 96 : opts.requestTargetBpm,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    return { ownerUserId, requestId, jobId, sessionId };
  }

  async function seedTrack(
    chain: { ownerUserId: string; requestId: string; jobId: string },
    providerTrackId: string,
  ): Promise<string> {
    const { id } = await insertGeneratedTrack(ctx.db, {
      ownerUserId: chain.ownerUserId,
      generationRequestId: chain.requestId,
      providerJobId: chain.jobId,
      providerKey: 'mock',
      providerTrackId,
      prompt: 'instrumental lofi',
      audio: { storageKey: 'audio/y.mp3', checksum: 'sum-y' },
    });
    return id;
  }

  it('lands a new provider track Ephemeral on insert (no age timer)', async () => {
    const { ownerUserId, requestId, jobId } = await seedChain();
    const { id } = await insertGeneratedTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      providerKey: 'mock',
      providerTrackId: 'mock-task-0',
      prompt: 'instrumental lofi, low energy',
      audio: { storageKey: 'audio/x.mp3', mimeType: 'audio/mpeg' },
    });

    const row = await getTrackForAnalysis(ctx.db, id);
    expect(row).not.toBeNull();
    // Ephemeral = the derived retention class with no saved/disliked flag.
    expect(deriveTrackRetentionClass({ savedAt: null, favoritedAt: null, dislikedAt: null })).toBe(
      'ephemeral',
    );
    expect(row?.status).toBe('ready');
    // A fresh track has never been analyzed.
    const raw = await rawTrackRow(ctx.db, id);
    expect(raw?.analysis_status).toBe('pending');
  });

  it("exposes the audio ref and the REQUEST's generation-time target BPM for analysis", async () => {
    const chain = await seedChain({ requestTargetBpm: 92 });
    const id = await seedTrack(chain, 'mock-task-1');

    const row = await getTrackForAnalysis(ctx.db, id);
    // The anchor is the request's own persisted target — NOT the live snapshot's
    // 96 (which a Change Vibe may have replaced since this track was generated).
    expect(row?.targetBpm).toBe(92);
    expect(row?.audio.storageKey).toBe('audio/y.mp3');
    expect(row?.audio.checksum).toBe('sum-y');
  });

  it('reports a null target for a legacy request', async () => {
    const chain = await seedChain({ requestTargetBpm: null });
    const id = await seedTrack(chain, 'mock-task-legacy');
    const row = await getTrackForAnalysis(ctx.db, id);
    expect(row?.targetBpm).toBeNull();
  });

  it('round-trips a full analysis write (measurements + provenance, no musicalKey)', async () => {
    const chain = await seedChain();
    const id = await seedTrack(chain, 'mock-task-2');
    const attemptedAt = new Date('2026-07-10T12:00:00Z');

    await writeTrackAnalysis(ctx.db, {
      trackId: id,
      bpmEstimate: 95.5,
      bpmSource: 'measured',
      bpmConfidence: 0.85,
      integratedLufs: -13.2,
      truePeakDb: -1.4,
      headBeatAnchorSeconds: 0.512,
      headBeatPeriodSeconds: 60 / 95.5,
      tailBeatAnchorSeconds: 180.25,
      tailBeatPeriodSeconds: 60 / 95.4,
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: attemptedAt,
      targetBpm: 96,
    });

    const raw = await rawTrackRow(ctx.db, id);
    expect(Number(raw?.bpm_estimate)).toBeCloseTo(95.5);
    expect(raw?.bpm_source).toBe('measured');
    expect(Number(raw?.bpm_confidence)).toBeCloseTo(0.85);
    expect(Number(raw?.lufs_integrated)).toBeCloseTo(-13.2);
    expect(Number(raw?.true_peak_db)).toBeCloseTo(-1.4);
    expect(Number(raw?.head_beat_anchor_seconds)).toBeCloseTo(0.512);
    expect(Number(raw?.tail_beat_anchor_seconds)).toBeCloseTo(180.25);
    expect(raw?.analysis_status).toBe('measured');
    expect(raw?.analysis_version).toBe(CURRENT_ANALYSIS_VERSION);
    expect(raw?.analysis_attempted_at).not.toBeNull();
    // The analyzer no longer writes musicalKey (measured key is deferred).
    expect(raw?.musical_key).toBeNull();
  });

  it.each([
    ['bpmEstimate below 40', { bpmEstimate: 20 }],
    ['bpmEstimate above 220', { bpmEstimate: 500 }],
    ['LUFS above 0', { integratedLufs: 3 }],
    ['LUFS below -70', { integratedLufs: -80 }],
    ['true peak above +3 dB', { truePeakDb: 6 }],
    ['negative head anchor', { headBeatAnchorSeconds: -1 }],
    ['confidence above 1', { bpmConfidence: 1.5 }],
    // 60/96 ≈ 0.625 s target period; 0.8 s deviates ~28% (> the ±10% guard).
    ['head period off the target grid', { headBeatPeriodSeconds: 0.8 }],
  ])('rejects an out-of-range analysis write: %s', async (_name, bad) => {
    const chain = await seedChain();
    const id = await seedTrack(chain, `mock-task-bad-${_name.replace(/\W+/g, '-')}`);

    await expect(
      writeTrackAnalysis(ctx.db, {
        trackId: id,
        analysisStatus: 'measured',
        analysisVersion: CURRENT_ANALYSIS_VERSION,
        analysisAttemptedAt: new Date(),
        targetBpm: 96,
        ...bad,
      }),
    ).rejects.toThrow(/refusing analysis write/);

    // Nothing landed: the track still reads as never analyzed.
    const raw = await rawTrackRow(ctx.db, id);
    expect(raw?.analysis_status).toBe('pending');
  });

  // --- Compare-and-set writes, boot-probe reset, backfill selection ---

  function analysisWrite(trackId: string, version: number, status: 'measured' | 'unavailable') {
    return writeTrackAnalysis(ctx.db, {
      trackId,
      ...(status === 'measured' ? { bpmEstimate: 96.2, bpmSource: 'measured' as const } : {}),
      analysisStatus: status,
      analysisVersion: version,
      analysisAttemptedAt: new Date(),
      targetBpm: 96,
    });
  }

  it('CAS: a stale in-flight job can never overwrite a newer analysis', async () => {
    const chain = await seedChain();
    const id = await seedTrack(chain, 'mock-task-cas-1');

    expect((await analysisWrite(id, CURRENT_ANALYSIS_VERSION, 'measured')).written).toBe(true);

    // An in-flight job from the PREVIOUS analyzer version finishes late.
    const stale = await writeTrackAnalysis(ctx.db, {
      trackId: id,
      bpmEstimate: 40,
      bpmSource: 'anchored',
      analysisStatus: 'unavailable',
      analysisVersion: CURRENT_ANALYSIS_VERSION - 1,
      analysisAttemptedAt: new Date(),
    });
    expect(stale.written).toBe(false);
    const raw = await rawTrackRow(ctx.db, id);
    expect(Number(raw?.bpm_estimate)).toBeCloseTo(96.2);
    expect(raw?.analysis_status).toBe('measured');
    expect(raw?.analysis_version).toBe(CURRENT_ANALYSIS_VERSION);
  });

  it('CAS: a duplicate re-run at the SAME version is a no-op', async () => {
    const chain = await seedChain();
    const id = await seedTrack(chain, 'mock-task-cas-2');
    expect((await analysisWrite(id, CURRENT_ANALYSIS_VERSION, 'measured')).written).toBe(true);
    expect((await analysisWrite(id, CURRENT_ANALYSIS_VERSION, 'measured')).written).toBe(false);
  });

  it('CAS: a newer analyzer version upgrades an older analysis', async () => {
    const chain = await seedChain();
    const id = await seedTrack(chain, 'mock-task-cas-3');
    expect((await analysisWrite(id, CURRENT_ANALYSIS_VERSION - 1, 'measured')).written).toBe(true);
    expect((await analysisWrite(id, CURRENT_ANALYSIS_VERSION, 'measured')).written).toBe(true);
  });

  it('boot-probe reset re-opens ONLY unavailable rows (pending + NULL version)', async () => {
    const chain = await seedChain();
    const unavailableId = await seedTrack(chain, 'mock-task-reset-1');
    const measuredId = await seedTrack(chain, 'mock-task-reset-2');
    await analysisWrite(unavailableId, CURRENT_ANALYSIS_VERSION, 'unavailable');
    await analysisWrite(measuredId, CURRENT_ANALYSIS_VERSION, 'measured');

    const reset = await resetUnavailableTrackAnalyses(ctx.db, {
      currentVersion: CURRENT_ANALYSIS_VERSION,
    });
    expect(reset).toEqual([unavailableId]);

    const raw = await rawTrackRow(ctx.db, unavailableId);
    expect(raw?.analysis_status).toBe('pending');
    expect(raw?.analysis_version).toBeNull();
    // ...which makes it writable again past the CAS guard.
    expect((await analysisWrite(unavailableId, CURRENT_ANALYSIS_VERSION, 'measured')).written).toBe(
      true,
    );
    const untouched = await rawTrackRow(ctx.db, measuredId);
    expect(untouched?.analysis_status).toBe('measured');
  });

  it('boot-probe reset never touches rows stamped by a NEWER analyzer version', async () => {
    // Rolling deployment: a version-N+1 worker recorded `unavailable`; an
    // older worker booting with ffmpeg must not clear that version and let
    // its own (older) analyzer win the row back past the CAS.
    const chain = await seedChain();
    const newerId = await seedTrack(chain, 'mock-task-reset-newer');
    await analysisWrite(newerId, CURRENT_ANALYSIS_VERSION + 1, 'unavailable');

    const reset = await resetUnavailableTrackAnalyses(ctx.db, {
      currentVersion: CURRENT_ANALYSIS_VERSION,
    });
    expect(reset).toEqual([]);
    const raw = await rawTrackRow(ctx.db, newerId);
    expect(raw?.analysis_status).toBe('unavailable');
    expect(raw?.analysis_version).toBe(CURRENT_ANALYSIS_VERSION + 1);
  });

  it('backfill selection: pending and old-version tracks, never current unavailable rows', async () => {
    const chain = await seedChain();
    const pendingId = await seedTrack(chain, 'mock-task-sel-pending');
    const oldVersionId = await seedTrack(chain, 'mock-task-sel-old');
    const currentId = await seedTrack(chain, 'mock-task-sel-current');
    const unavailableId = await seedTrack(chain, 'mock-task-sel-unavail');
    await analysisWrite(oldVersionId, CURRENT_ANALYSIS_VERSION - 1, 'measured');
    await analysisWrite(currentId, CURRENT_ANALYSIS_VERSION, 'measured');
    // An ffmpeg-less host marked this at the CURRENT version: parked until the
    // boot probe resets it (the "unavailable non-reselection" rule).
    await analysisWrite(unavailableId, CURRENT_ANALYSIS_VERSION, 'unavailable');

    const selected = await listTracksNeedingAnalysis(ctx.db, {
      currentVersion: CURRENT_ANALYSIS_VERSION,
      limit: 10,
    });
    expect(selected).toContain(pendingId);
    expect(selected).toContain(oldVersionId);
    expect(selected).not.toContain(currentId);
    expect(selected).not.toContain(unavailableId);

    // After the boot-probe reset, the unavailable track becomes selectable.
    await resetUnavailableTrackAnalyses(ctx.db, { currentVersion: CURRENT_ANALYSIS_VERSION });
    const afterReset = await listTracksNeedingAnalysis(ctx.db, {
      currentVersion: CURRENT_ANALYSIS_VERSION,
      limit: 10,
    });
    expect(afterReset).toContain(unavailableId);
  });

  it('backfill selection: skips tracks without a downloaded final and honors the limit', async () => {
    const chain = await seedChain();
    const withAudio1 = await seedTrack(chain, 'mock-task-sel-a1');
    const withAudio2 = await seedTrack(chain, 'mock-task-sel-a2');
    const { id: noAudioId } = await insertGeneratedTrack(ctx.db, {
      ownerUserId: chain.ownerUserId,
      generationRequestId: chain.requestId,
      providerJobId: chain.jobId,
      providerKey: 'mock',
      providerTrackId: 'mock-task-sel-noaudio',
      prompt: 'instrumental lofi',
      status: 'streamable',
    });

    const selected = await listTracksNeedingAnalysis(ctx.db, {
      currentVersion: CURRENT_ANALYSIS_VERSION,
      limit: 10,
    });
    expect(selected).not.toContain(noAudioId);
    expect(selected).toEqual(expect.arrayContaining([withAudio1, withAudio2]));

    const limited = await listTracksNeedingAnalysis(ctx.db, {
      currentVersion: CURRENT_ANALYSIS_VERSION,
      limit: 1,
    });
    expect(limited).toHaveLength(1);
  });

  it('counts non-deleted tracks by analysis status, zero-filling absent statuses', async () => {
    const chain = await seedChain();
    await seedTrack(chain, 'mock-task-count-pending');
    const measuredId = await seedTrack(chain, 'mock-task-count-measured');
    const partialId = await seedTrack(chain, 'mock-task-count-partial');
    const deletedId = await seedTrack(chain, 'mock-task-count-deleted');
    await analysisWrite(measuredId, CURRENT_ANALYSIS_VERSION, 'measured');
    await writeTrackAnalysis(ctx.db, {
      trackId: partialId,
      integratedLufs: -13.5,
      analysisStatus: 'partial',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });
    // A deleted track's row lingers until retention cleanup — it must not count.
    await ctx.pool.query(`update tracks set status = 'deleted' where id = $1`, [deletedId]);

    expect(await countTracksByAnalysisStatus(ctx.db)).toEqual({
      pending: 1,
      measured: 1,
      partial: 1,
      unavailable: 0,
      failed: 0,
    });
  });
});
