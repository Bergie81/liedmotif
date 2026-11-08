// Fixture builders for the generation/controller integration suites (real
// Postgres via TEST_DATABASE_URL). Not a test file (no `.test.ts`) and never in
// the runtime bundle. These insert the dependency chain
// user → session → generation_request → provider_job → track(+assets) directly
// (raw Drizzle inserts), so a suite can stage any retention/lifecycle state —
// including states the production writers would never create on purpose (e.g. a
// disliked track) — without routing through the repo under test. The account
// rows that chain hangs off (the user, and the Logins they hold) are staged
// here too, so there is ONE fixture surface rather than one per table family.

import { sql } from 'drizzle-orm';
import type {
  SessionGenerationStatus,
  SessionMode,
  TimedLyrics,
  VocalMode,
} from '@liedmotif/shared';
import type { Database } from '../client';
import {
  activitySessions,
  activitySessionQueueItems,
  coverImages,
  generationRequests,
  playbackEvents,
  providerJobs,
  providerSubmitState,
  session,
  tracks,
  trackAudioAssets,
  user,
  type StructuredControls,
  type StyleSnapshot,
} from '../schema';

let counter = 0;
/** A process-unique suffix so repeated fixture rows never collide on unique cols. */
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export async function createUser(
  db: Database,
  overrides: Partial<{ id: string }> = {},
): Promise<string> {
  const id = overrides.id ?? uniq('user');
  await db
    .insert(user)
    .values({ id, name: 'Test Admin', email: `${id}@example.test` })
    .onConflictDoNothing();
  return id;
}

/**
 * A live Login for a user — the row a browser session cookie is backed by, and
 * what a suite seeds to assert that a revocation actually evicts one.
 */
export async function createLogin(
  db: Database,
  ownerUserId: string,
  token = uniq('login'),
): Promise<string> {
  await db.insert(session).values({
    id: token,
    token,
    userId: ownerUserId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  });
  return token;
}

/**
 * Who still holds a live Login, sorted — the read that makes a revocation's
 * blast radius visible, including the users it had to leave alone.
 */
export async function liveLoginOwnerIds(db: Database): Promise<string[]> {
  const rows = await db.select({ userId: session.userId }).from(session);
  return rows.map((row) => row.userId).sort();
}

/**
 * A cover image row (instance-global — cover images carry no owner), for suites
 * that assert on which cover a Session/track/playlist row resolves to.
 */
export async function createCoverImage(db: Database): Promise<string> {
  const [row] = await db
    .insert(coverImages)
    .values({
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: `covers/test/${uniq('cover')}.webp`,
    })
    .returning({ id: coverImages.id });
  return row!.id;
}

export interface SessionFixture {
  ownerUserId: string;
  status?: 'active' | 'stopped';
  sessionMode?: SessionMode;
  generationStatus?: SessionGenerationStatus;
  styleSnapshot?: StyleSnapshot;
  targetDurationMinutes?: number | null;
  idleAutoStopAfterMinutes?: number;
  startedAt?: Date;
  lastResumedAt?: Date | null;
  lastPlaybackReportAt?: Date | null;
  title?: string | null;
  coverStyle?: (typeof activitySessions.$inferInsert)['coverStyle'];
  coverStyleHint?: string | null;
  useStandardCover?: boolean;
  coverImageId?: string | null;
  userPrompt?: string | null;
  structuredControls?: StructuredControls | null;
}

export async function createSession(db: Database, fx: SessionFixture): Promise<string> {
  const [row] = await db
    .insert(activitySessions)
    .values({
      ownerUserId: fx.ownerUserId,
      status: fx.status ?? 'active',
      sessionMode: fx.sessionMode ?? 'keep_going',
      generationStatus: fx.generationStatus ?? 'ok',
      sessionStyleSnapshot: fx.styleSnapshot ?? null,
      targetDurationMinutes: fx.targetDurationMinutes ?? null,
      idleAutoStopAfterMinutes: fx.idleAutoStopAfterMinutes ?? 15,
      ...(fx.startedAt ? { startedAt: fx.startedAt } : {}),
      lastResumedAt: fx.lastResumedAt ?? null,
      lastPlaybackReportAt: fx.lastPlaybackReportAt ?? null,
      ...(fx.title !== undefined ? { title: fx.title } : {}),
      ...(fx.userPrompt !== undefined ? { userPrompt: fx.userPrompt } : {}),
      ...(fx.structuredControls !== undefined ? { structuredControls: fx.structuredControls } : {}),
      ...(fx.coverStyle !== undefined ? { coverStyle: fx.coverStyle } : {}),
      ...(fx.coverStyleHint !== undefined ? { coverStyleHint: fx.coverStyleHint } : {}),
      ...(fx.useStandardCover !== undefined ? { useStandardCover: fx.useStandardCover } : {}),
      ...(fx.coverImageId !== undefined ? { coverImageId: fx.coverImageId } : {}),
    })
    .returning({ id: activitySessions.id });
  return row!.id;
}

export interface RequestFixture {
  ownerUserId: string;
  activitySessionId?: string;
  source?: 'prompt' | 'controls' | 'more_like_this' | 'change_vibe';
  providerKey?: string;
  status?: string;
  stylePrompt?: string | null;
  /** The text-LLM expansion; omitted → null (structured/no-LLM path). */
  expandedPrompt?: string | null;
  /** The session prompt history frozen at submit; omitted → null (a legacy row). */
  userPrompt?: string | null;
  titleSeed?: number | null;
  /** The persisted early title tease; omitted → null. */
  earlyTrackTitle?: string | null;
  /** Generation-time blend identity; omitted → null (a legacy request). */
  styleRevision?: number | null;
  targetBpm?: number | null;
  targetKey?: string | null;
  /** The compilation snapshot the request was generated from (reroll context). */
  styleSnapshot?: StyleSnapshot | null;
  createdAt?: Date;
}

export async function createGenerationRequest(db: Database, fx: RequestFixture): Promise<string> {
  const [row] = await db
    .insert(generationRequests)
    .values({
      ownerUserId: fx.ownerUserId,
      activitySessionId: fx.activitySessionId ?? null,
      source: fx.source ?? 'controls',
      providerType: 'music',
      providerKey: fx.providerKey ?? 'mock',
      // The production insert path's value (`status` is diagnostic — see schema).
      status: fx.status ?? 'submitting',
      stylePrompt: fx.stylePrompt ?? null,
      expandedPrompt: fx.expandedPrompt ?? null,
      userPrompt: fx.userPrompt ?? null,
      titleSeed: fx.titleSeed ?? null,
      earlyTrackTitle: fx.earlyTrackTitle ?? null,
      styleRevision: fx.styleRevision ?? null,
      targetBpm: fx.targetBpm ?? null,
      targetKey: fx.targetKey ?? null,
      styleSnapshot: fx.styleSnapshot ?? null,
      ...(fx.createdAt ? { createdAt: fx.createdAt } : {}),
    })
    .returning({ id: generationRequests.id });
  return row!.id;
}

export interface ProviderJobFixture {
  generationRequestId: string;
  providerKey?: string;
  providerTaskId?: string | null;
  submitState?: (typeof providerSubmitState.enumValues)[number];
  normalizedStatus?: string;
  createdAt?: Date;
  /** Stages the job's last-write time (block-signal cooldowns / phantom age bounds). */
  updatedAt?: Date;
}

export async function createProviderJob(db: Database, fx: ProviderJobFixture): Promise<string> {
  const [row] = await db
    .insert(providerJobs)
    .values({
      generationRequestId: fx.generationRequestId,
      providerType: 'music',
      providerKey: fx.providerKey ?? 'mock',
      // undefined → mint a unique task id; explicit null → genuinely no task id.
      providerTaskId: fx.providerTaskId === undefined ? uniq('task') : fx.providerTaskId,
      submitState: fx.submitState ?? 'submitted',
      normalizedStatus: (fx.normalizedStatus ?? 'ready') as never,
      ...(fx.createdAt ? { createdAt: fx.createdAt } : {}),
      ...(fx.updatedAt ? { updatedAt: fx.updatedAt } : {}),
    })
    .returning({ id: providerJobs.id });
  return row!.id;
}

export interface TrackFixture {
  ownerUserId: string;
  generationRequestId: string;
  providerJobId: string;
  providerTrackId?: string;
  providerKey?: string;
  prompt?: string;
  status?: 'pending' | 'streamable' | 'ready' | 'rejected' | 'deleted' | 'failed';
  savedAt?: Date | null;
  favoritedAt?: Date | null;
  dislikedAt?: Date | null;
  bpmEstimate?: number | null;
  musicalKey?: string | null;
  createdAt?: Date;
  genreTags?: string[];
  /** When set, also inserts a local-final audio asset with this storage key. */
  audioStorageKey?: string;
  /** Recorded MIME type of the local-final asset (with `audioStorageKey`). */
  audioMimeType?: string;
  /** Recorded byte size of the local-final asset (with `audioStorageKey`). */
  audioByteSize?: number;
  /** When set, also inserts a provider-stream asset with this encrypted URL. */
  streamEncryptedSourceUrl?: string;
  /** Dislike-reroll intent (fresh-call reroll awaiting the buffer controller). */
  rerollPendingAt?: Date | null;
  /** Analysis provenance + measurements. */
  analysisStatus?: 'pending' | 'measured' | 'partial' | 'unavailable' | 'failed';
  analysisVersion?: number | null;
  bpmSource?: 'measured' | 'anchored' | null;
  bpmConfidence?: number | null;
  lufsIntegrated?: number | null;
  truePeakDb?: number | null;
  headBeatAnchorSeconds?: number | null;
  headBeatPeriodSeconds?: number | null;
  tailBeatAnchorSeconds?: number | null;
  tailBeatPeriodSeconds?: number | null;
  vocalMode?: VocalMode;
  lyrics?: string | null;
  timedLyrics?: TimedLyrics | null;
  title?: string | null;
  durationSeconds?: number | null;
  providerModel?: string | null;
  rightsNote?: string | null;
  activity?: string | null;
  mood?: string | null;
  energy?: string | null;
}

export async function createTrack(db: Database, fx: TrackFixture): Promise<string> {
  const [row] = await db
    .insert(tracks)
    .values({
      ownerUserId: fx.ownerUserId,
      generationRequestId: fx.generationRequestId,
      providerJobId: fx.providerJobId,
      providerKey: fx.providerKey ?? 'mock',
      providerTrackId: fx.providerTrackId ?? uniq('ptrack'),
      prompt: fx.prompt ?? 'instrumental lofi, low energy',
      status: fx.status ?? 'ready',
      savedAt: fx.savedAt ?? null,
      favoritedAt: fx.favoritedAt ?? null,
      dislikedAt: fx.dislikedAt ?? null,
      bpmEstimate: fx.bpmEstimate ?? null,
      musicalKey: fx.musicalKey ?? null,
      ...(fx.genreTags !== undefined ? { genreTags: fx.genreTags } : {}),
      rerollPendingAt: fx.rerollPendingAt ?? null,
      ...(fx.analysisStatus !== undefined ? { analysisStatus: fx.analysisStatus } : {}),
      analysisVersion: fx.analysisVersion ?? null,
      bpmSource: fx.bpmSource ?? null,
      bpmConfidence: fx.bpmConfidence ?? null,
      lufsIntegrated: fx.lufsIntegrated ?? null,
      truePeakDb: fx.truePeakDb ?? null,
      headBeatAnchorSeconds: fx.headBeatAnchorSeconds ?? null,
      headBeatPeriodSeconds: fx.headBeatPeriodSeconds ?? null,
      tailBeatAnchorSeconds: fx.tailBeatAnchorSeconds ?? null,
      tailBeatPeriodSeconds: fx.tailBeatPeriodSeconds ?? null,
      ...(fx.vocalMode !== undefined ? { vocalMode: fx.vocalMode } : {}),
      lyrics: fx.lyrics ?? null,
      timedLyrics: fx.timedLyrics ?? null,
      title: fx.title ?? null,
      durationSeconds: fx.durationSeconds ?? null,
      providerModel: fx.providerModel ?? null,
      rightsNote: fx.rightsNote ?? null,
      activity: fx.activity ?? null,
      mood: fx.mood ?? null,
      energy: fx.energy ?? null,
      ...(fx.createdAt ? { createdAt: fx.createdAt } : {}),
    })
    .returning({ id: tracks.id });
  const trackId = row!.id;
  if (fx.audioStorageKey) {
    await db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'local_original',
      storageProvider: 'local-fs',
      storageKey: fx.audioStorageKey,
      mimeType: fx.audioMimeType ?? null,
      byteSize: fx.audioByteSize ?? null,
      isPlayable: true,
    });
  }
  if (fx.streamEncryptedSourceUrl) {
    await db.insert(trackAudioAssets).values({
      trackId,
      assetType: 'provider_stream',
      storageProvider: 'provider',
      encryptedSourceUrl: fx.streamEncryptedSourceUrl,
      isPlayable: true,
    });
  }
  return trackId;
}

/**
 * One queue slot backed by a track from its own request at the given style
 * revision — the request+job+track+item assembly the vibe-switch suites keep
 * needing. Playable by default (a provider-stream asset).
 */
export async function createQueueSlotAtRevision(
  db: Database,
  fx: {
    ownerUserId: string;
    activitySessionId: string;
    styleRevision: number | null;
    position: number;
    state?: 'queued' | 'playing' | 'played' | 'skipped';
    playable?: boolean;
  },
): Promise<{ requestId: string; trackId: string; queueItemId: string }> {
  const requestId = await createGenerationRequest(db, {
    ownerUserId: fx.ownerUserId,
    activitySessionId: fx.activitySessionId,
    styleRevision: fx.styleRevision,
  });
  const jobId = await createProviderJob(db, { generationRequestId: requestId });
  const trackId = await createTrack(db, {
    ownerUserId: fx.ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    providerTrackId: uniq(`slot-r${fx.styleRevision ?? 'null'}-p${fx.position}`),
    status: 'ready',
    ...(fx.playable === false ? {} : { streamEncryptedSourceUrl: uniq('enc:stream') }),
  });
  const queueItemId = await createQueueItem(db, {
    activitySessionId: fx.activitySessionId,
    trackId,
    generationRequestId: requestId,
    position: fx.position,
    state: fx.state ?? 'queued',
  });
  return { requestId, trackId, queueItemId };
}

/** Insert a persisted `started` playback event so a track reads as "played". */
export async function markTrackPlayed(
  db: Database,
  fx: { ownerUserId: string; activitySessionId: string; trackId: string },
): Promise<void> {
  await db.insert(playbackEvents).values({
    ownerUserId: fx.ownerUserId,
    activitySessionId: fx.activitySessionId,
    trackId: fx.trackId,
    eventType: 'started',
    clientTimestamp: new Date(),
  });
}

/** Insert a queue item pointing at a track (defaults to a ready-ahead `queued` slot). */
export async function createQueueItem(
  db: Database,
  fx: {
    activitySessionId: string;
    trackId?: string;
    generationRequestId?: string;
    position: number;
    state?:
      | 'planned'
      | 'generating'
      | 'queued'
      | 'playing'
      | 'played'
      | 'skipped'
      | 'rejected'
      | 'failed';
  },
): Promise<string> {
  const [row] = await db
    .insert(activitySessionQueueItems)
    .values({
      activitySessionId: fx.activitySessionId,
      trackId: fx.trackId ?? null,
      generationRequestId: fx.generationRequestId ?? null,
      position: fx.position,
      state: fx.state ?? 'queued',
    })
    .returning({ id: activitySessionQueueItems.id });
  return row!.id;
}

/** The tables these fixtures touch, for a suite's `truncateTables` reset. */
export const GENERATION_FIXTURE_TABLES = [
  'session_cover_generations',
  'playback_events',
  'feedback_events',
  'deletion_queue_items',
  'track_audio_assets',
  'activity_session_queue_items',
  'tracks',
  'provider_jobs',
  'generation_requests',
  'activity_sessions',
  'user',
] as const;

/** Convenience: a minimal owner + active session + one ready ephemeral track. */
export async function seedReadyTrack(
  db: Database,
  overrides: { ownerUserId?: string; sessionId?: string } = {},
): Promise<{
  ownerUserId: string;
  sessionId: string;
  requestId: string;
  jobId: string;
  trackId: string;
}> {
  const ownerUserId = overrides.ownerUserId ?? (await createUser(db));
  const sessionId = overrides.sessionId ?? (await createSession(db, { ownerUserId }));
  const requestId = await createGenerationRequest(db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(db, { generationRequestId: requestId });
  const trackId = await createTrack(db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    audioStorageKey: uniq('audio') + '.mp3',
  });
  return { ownerUserId, sessionId, requestId, jobId, trackId };
}

/**
 * One Track of a Session under its own request and job, listed unless the
 * `status`, `dislikedAt`, `queueState` or `playable: false` given here says otherwise.
 */
export async function seedSessionTrack(
  db: Database,
  ownerUserId: string,
  sessionId: string,
  track: Pick<TrackFixture, 'title' | 'status' | 'dislikedAt' | 'createdAt' | 'genreTags'> & {
    queueState?: 'rejected';
    playable?: boolean;
  } = {},
): Promise<string> {
  const { queueState, playable = true, ...columns } = track;
  const requestId = await createGenerationRequest(db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(db, { generationRequestId: requestId });
  const trackId = await createTrack(db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    ...columns,
    ...(playable ? { audioStorageKey: uniq('audio') + '.mp3' } : {}),
  });
  if (queueState) {
    await createQueueItem(db, {
      activitySessionId: sessionId,
      trackId,
      generationRequestId: requestId,
      position: 0,
      state: queueState,
    });
  }
  return trackId;
}

/** Raw helper for suites that need to assert on a column directly. */
export async function rawTrackRow(
  db: Database,
  trackId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db.execute(sql`select * from tracks where id = ${trackId}`);
  return (rows as unknown as { rows: Record<string, unknown>[] }).rows[0];
}
