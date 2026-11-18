// The server-authoritative session QUEUE view (`getSessionQueue`): each item carries
// the generation-time blend identity, the per-source asset presence,
// and the persisted analysis fields. The queue read is the player's single
// source of truth for play order; the route maps these records to the shared
// contract (pinned audio paths, stale-suppressed `blendAnalysis`).

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  LIVE_QUEUE_ITEM_STATES,
  PARKED_SUBMIT_STATUSES,
  PHANTOM_SUBMIT_PROVIDER_STATUSES,
} from '@liedmotif/shared';
import type {
  ProviderNormalizedStatus,
  SessionGenerationStatus,
  SessionMode,
  TrackAnalysisFields,
  VocalMode,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { curatedPlaylistMemberColumn } from '../playlists/curated-membership';
import { inFlightProviderJobCondition } from './limits-repo';
import { trackHasLyricsColumn } from './lyrics-repo';
import { queueItemRequestEdge } from './queue-request-edge';
import { sessionDurationColumns } from './session-duration-repo';
import { notUnbilledRefusal } from './sessions-repo';
import {
  activitySessions,
  activitySessionQueueItems,
  generationRequests,
  providerJobs,
  tracks,
  trackAudioAssets,
  type StructuredControls,
} from '../schema';

/** The three per-track asset questions, answered together (null = no asset rows). */
interface TrackAssetFlags {
  playable: boolean | null;
  final: boolean | null;
  stream: boolean | null;
}

/** The asset row is the downloaded final render the player can pin. */
const pinnedFinalAsset = sql`${trackAudioAssets.assetType} = 'local_original' and ${trackAudioAssets.isPlayable} and ${trackAudioAssets.storageKey} is not null`;
/** The asset row is the provider stream the player can pin. */
const pinnedStreamAsset = sql`${trackAudioAssets.assetType} = 'provider_stream' and ${trackAudioAssets.isPlayable} and ${trackAudioAssets.encryptedSourceUrl} is not null`;

/**
 * One correlated pass over a track's audio assets answering all three presence
 * questions: the queue read runs on every poll, so the per-row subquery count is
 * load-bearing. `bool_or` over zero rows yields nulls — the caller maps to false.
 */
function trackAssetFlagsColumn(): SQL<TrackAssetFlags | null> {
  return sql<TrackAssetFlags | null>`(
    select json_build_object(
      'playable', bool_or(${trackAudioAssets.isPlayable}),
      'final', bool_or(${pinnedFinalAsset}),
      'stream', bool_or(${pinnedStreamAsset})
    ) from ${trackAudioAssets} where ${trackAudioAssets.trackId} = ${tracks.id}
  )`;
}

/** The slot's Track carries a source the player's queue projection plays
 * from — the server-side twin of that projection's entry rule, under which a
 * failed Track offers none. */
const slotHasPinnedSource = sql`${tracks.status} <> 'failed' and exists (
  select 1 from ${trackAudioAssets}
  where ${trackAudioAssets.trackId} = ${tracks.id}
    and ((${pinnedFinalAsset}) or (${pinnedStreamAsset}))
)`;

export interface SessionQueueTrack {
  id: string;
  title: string | null;
  generatedArtistName: string | null;
  status: 'pending' | 'streamable' | 'ready' | 'rejected' | 'deleted' | 'failed';
  durationSeconds: number | null;
  coverImageId: string | null;
  savedAt: Date | null;
  favoritedAt: Date | null;
  dislikedAt: Date | null;
  inCuratedPlaylist: boolean;
  genreTags: string[];
  vocalMode: VocalMode;
  /** True once the provider-written lyric text is captured (vocal tracks only). */
  hasLyrics: boolean;
  /** True when a playable audio asset exists (the route maps it to an app audio path). */
  hasPlayableAudio: boolean;
  /** True when the DOWNLOADED local final is servable (the `?asset=final` pin). */
  hasFinalAsset: boolean;
  /** True when a cold-start provider-stream asset is servable (the `?asset=stream` pin). */
  hasStreamAsset: boolean;
  /** Persisted analysis provenance + measurements;
   *  the route maps them to the contract's `blendAnalysis` (stale-suppressed). */
  analysis: TrackAnalysisFields;
}

export interface SessionQueueItemRecord {
  id: string;
  position: number;
  state:
    'planned' | 'generating' | 'queued' | 'playing' | 'played' | 'skipped' | 'rejected' | 'failed';
  /** True only when switch-now Change Vibe set this item aside. */
  vibeSwitchSetAside: boolean;
  trackId: string | null;
  track: SessionQueueTrack | null;
  /** Generation-time blend identity from the slot's request (null = legacy → plain edge). */
  targetBpm: number | null;
  targetKey: string | null;
  styleRevision: number | null;
}

/** The session's latest in-flight provider job while nothing is playable yet
 * — the raw state the route maps to the contract's `pendingGeneration`
 * (stage + timestamp; never task ids or URLs). */
export interface SessionQueuePendingGeneration {
  normalizedStatus: ProviderNormalizedStatus;
  /** The provider submit time; the job row's creation until a submit lands. */
  submittedAt: Date;
  /** The persisted early title tease; null until the text stage
   *  yields one. */
  earlyTrackTitle: string | null;
}

/**
 * The six Style-Snapshot facets the queue route's `vibe` payload projects,
 * extracted in SQL so the full 1–4 KB snapshot never rides the 1–4 s poll.
 * `->` preserves JSON types, so the route sees exactly the shapes it would
 * read from the full snapshot; the values stay unvalidated (`unknown`) because
 * narrowing them is the route's job.
 */
export interface QueueSessionStyleFacets {
  genreTags: unknown;
  energy: unknown;
  vocalMode: unknown;
  voiceGender: unknown;
  useOwnVoice: unknown;
  language: unknown;
  styleStrength: unknown;
  novelty: unknown;
  userAvoid: unknown;
}

/** The session slice the queue poll needs — command paths keep the full
 * `sessionColumns` record; this projection exists so the hottest read in the
 * app never drags the snapshot, cover concept, or prompt internals along. */
export interface QueueSessionRecord {
  id: string;
  status: 'active' | 'stopped';
  sessionMode: SessionMode;
  generationStatus: SessionGenerationStatus;
  generationStatusScope: 'member' | 'pool' | null;
  targetDurationMinutes: number | null;
  generatedDurationSeconds: number;
  unknownDurationTrackCount: number;
  statusMessageSafe: string | null;
  coverImageId: string | null;
  styleRevision: number;
  vibeSwitchRevision: number | null;
  /** The live revision has bought (or may have bought) its initial fill — the
   *  worker's `hasCurrentRevisionGenerated`, read on the same terms. */
  liveRevisionFillSpent: boolean;
  currentTrackId: string | null;
  currentQueueItemId: string | null;
  userPrompt: string | null;
  structuredControls: StructuredControls | null;
  /** Null while the session has no Style Snapshot yet. */
  styleFacets: QueueSessionStyleFacets | null;
}

const queueSessionColumns = {
  id: activitySessions.id,
  status: activitySessions.status,
  sessionMode: activitySessions.sessionMode,
  generationStatus: activitySessions.generationStatus,
  generationStatusScope: activitySessions.generationStatusScope,
  targetDurationMinutes: activitySessions.targetDurationMinutes,
  ...sessionDurationColumns(sql`${activitySessions.id}`, sql`${activitySessions.ownerUserId}`),
  statusMessageSafe: activitySessions.statusMessageSafe,
  coverImageId: activitySessions.coverImageId,
  styleRevision: activitySessions.styleRevision,
  vibeSwitchRevision: activitySessions.vibeSwitchRevision,
  currentTrackId: activitySessions.currentTrackId,
  currentQueueItemId: activitySessions.currentQueueItemId,
  userPrompt: activitySessions.userPrompt,
  structuredControls: activitySessions.structuredControls,
  styleFacets: sql<QueueSessionStyleFacets | null>`case
    when ${activitySessions.sessionStyleSnapshot} is null then null
    else jsonb_build_object(
      'genreTags', ${activitySessions.sessionStyleSnapshot} -> 'genreTags',
      'energy', ${activitySessions.sessionStyleSnapshot} -> 'energy',
      'vocalMode', ${activitySessions.sessionStyleSnapshot} -> 'vocalMode',
      'voiceGender', ${activitySessions.sessionStyleSnapshot} -> 'voiceGender',
      'useOwnVoice', ${activitySessions.sessionStyleSnapshot} -> 'useOwnVoice',
      'language', ${activitySessions.sessionStyleSnapshot} -> 'language',
      'styleStrength', ${activitySessions.sessionStyleSnapshot} -> 'styleStrength',
      'novelty', ${activitySessions.sessionStyleSnapshot} -> 'novelty',
      'userAvoid', ${activitySessions.sessionStyleSnapshot} -> 'userAvoid'
    )
  end`,
} as const;

export interface SessionQueueView {
  session: QueueSessionRecord;
  items: SessionQueueItemRecord[];
  /** Slots elided from `items` by the read window. */
  earlier: number;
  /** The elided slots the player's projection would hold (a pinned source, still
   * in the Session): the offset that numbers Tracks across the whole Session. */
  earlierTracks: number;
  /** The Session's first playable slot (still in the Session, with a pinned
   * final or stream source) when the window leaves it out; null when `items`
   * already starts the Session. Ordered play wraps to it. */
  loopHead: SessionQueueItemRecord | null;
  /** Null once any queue item carries a playable source (or no job exists). */
  pendingGeneration: SessionQueuePendingGeneration | null;
  /** What the session's in-flight provider work still owes the listener, in
   *  TRACKS (the repo-wide user-facing unit). */
  generatingTracksAhead: number;
  /** The part of it whose requests carry the session's live Style Snapshot
   *  revision or newer. A session that never changed vibe has all of it here;
   *  only a caller that knows a vibe change happened can read this as "the new
   *  vibe is on its way". */
  generatingNewVibeTracksAhead: number;
}

/**
 * How many consumed slots stay in the read behind the current item (recent
 * queue-sheet scrollback). Played/skipped/failed slots stay in the order
 * forever, so without this window every poll's payload, parse, and render would
 * grow with session length without bound.
 */
const PLAYED_WINDOW_SLOTS = 30;

/**
 * A Dislike (reroll) or Delete Track removes the Track from the Session; the
 * rows stay for retention/audit. A live slot flips to `rejected`, but a
 * terminal `played`/`skipped`/`failed` slot keeps its state, so the Track's own
 * `rejected`/`deleted` status is what marks it removed there. Every Queue
 * surface — Track numbering, counts, queue sheet — reads THIS view, so excluding
 * both once here is what makes a removed Track gone everywhere, on every device,
 * after a reload. Reads `tracks`, so every query using it left-joins the slot's track.
 */
const slotStillInSession = and(
  ne(activitySessionQueueItems.state, 'rejected'),
  or(isNull(tracks.id), notInArray(tracks.status, ['rejected', 'deleted'])),
);

/**
 * The server-authoritative queue for an owned session (the single source of truth
 * for play order). Each item resolves its track (when one is attached) with the
 * fields the player's `trackSummary` needs; `hasPlayableAudio` lets the route decide
 * whether to expose an app-routed audio path (provider URLs never reach the client).
 *
 * The read is WINDOWED unless `fullRead` asks for every slot: the last
 * `PLAYED_WINDOW_SLOTS` slots before the anchor plus everything from it
 * forward; older slots collapse into `earlier`, and the first playable of them
 * rides along as `loopHead`. The anchor is the current item, or the first
 * unconsumed slot when the session carries no current item (see `anchorPosition`).
 */
export async function getSessionQueue(
  db: Database,
  args: {
    ownerUserId: string;
    sessionId: string;
    /** Read every slot instead of the window (Shuffle traverses the whole
     *  Session); nothing is elided, so there is no loop head either. */
    fullRead?: boolean;
    /** The shared phantom-submit slot-hold bound (`phantomSubmitCutoffAt`). */
    phantomSubmitCutoff: Date;
    /** The music provider's `typicalTracksPerRequest` — how many Tracks one
     *  in-flight provider call is expected to yield. */
    tracksPerRequest: number;
  },
): Promise<SessionQueueView | null> {
  const [row] = await db
    .select({
      ...queueSessionColumns,
      generatingTracksAhead: generatingTracksColumn(db, args),
      // Scoped against the session row's OWN revision, in the same read: a
      // Change Vibe landing mid-poll can never file old-revision work as new.
      generatingNewVibeTracksAhead: generatingTracksColumn(
        db,
        args,
        gte(generationRequests.styleRevision, activitySessions.styleRevision),
      ),
      liveRevisionFillSpent: liveRevisionFillSpentColumn(db),
    })
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const { generatingTracksAhead, generatingNewVibeTracksAhead, ...session } = row;

  const { windowStartPosition, earlier, earlierTracks } = args.fullRead
    ? FULL_READ
    : await resolveQueueWindow(db, args.sessionId, session.currentQueueItemId);

  const sessionSlots = and(
    eq(activitySessionQueueItems.activitySessionId, args.sessionId),
    slotStillInSession,
  );
  const items = await selectQueueItems(
    db,
    windowStartPosition == null
      ? sessionSlots
      : and(sessionSlots, gte(activitySessionQueueItems.position, windowStartPosition)),
  );
  const [loopHead = null] =
    windowStartPosition == null
      ? []
      : await selectQueueItems(
          db,
          and(
            sessionSlots,
            lt(activitySessionQueueItems.position, windowStartPosition),
            slotHasPinnedSource,
          ),
          1,
        );

  // Cold start only: while NO item carries a playable source, fetch the
  // session's latest provider job so the player can narrate what is happening.
  // The same predicate the client projection plays from (a pinned final or
  // stream asset), so the signal disappears exactly when playback can begin.
  const hasPlayable = items.some(
    (item) =>
      item.track &&
      item.track.status !== 'failed' &&
      (item.track.hasFinalAsset || item.track.hasStreamAsset),
  );
  const pendingGeneration = hasPlayable
    ? null
    : await latestProviderJobState(db, args.sessionId, args.phantomSubmitCutoff);
  return {
    session,
    items,
    earlier,
    earlierTracks,
    loopHead,
    pendingGeneration,
    generatingTracksAhead,
    generatingNewVibeTracksAhead,
  };
}

/** The Queue slots `where` selects, in play order, each with its Track resolved
 * for the player. Reads `tracks`, so `where` may use `slotStillInSession`. */
async function selectQueueItems(
  db: Database,
  where: SQL | undefined,
  limit?: number,
): Promise<SessionQueueItemRecord[]> {
  const query = db
    .select({
      id: activitySessionQueueItems.id,
      position: activitySessionQueueItems.position,
      state: activitySessionQueueItems.state,
      vibeSwitchSetAside: activitySessionQueueItems.vibeSwitchSetAside,
      trackId: activitySessionQueueItems.trackId,
      trackTitle: tracks.title,
      generatedArtistName: tracks.generatedArtistName,
      trackStatus: tracks.status,
      durationSeconds: tracks.durationSeconds,
      coverImageId: tracks.coverImageId,
      savedAt: tracks.savedAt,
      favoritedAt: tracks.favoritedAt,
      dislikedAt: tracks.dislikedAt,
      inCuratedPlaylist: curatedPlaylistMemberColumn(db),
      genreTags: tracks.genreTags,
      vocalMode: tracks.vocalMode,
      hasLyrics: trackHasLyricsColumn(),
      assetFlags: trackAssetFlagsColumn(),
      analysisStatus: tracks.analysisStatus,
      analysisVersion: tracks.analysisVersion,
      bpmEstimate: tracks.bpmEstimate,
      bpmSource: tracks.bpmSource,
      bpmConfidence: tracks.bpmConfidence,
      headBeatAnchorSeconds: tracks.headBeatAnchorSeconds,
      headBeatPeriodSeconds: tracks.headBeatPeriodSeconds,
      tailBeatAnchorSeconds: tracks.tailBeatAnchorSeconds,
      tailBeatPeriodSeconds: tracks.tailBeatPeriodSeconds,
      lufsIntegrated: tracks.lufsIntegrated,
      truePeakDb: tracks.truePeakDb,
      targetBpm: generationRequests.targetBpm,
      targetKey: generationRequests.targetKey,
      styleRevision: generationRequests.styleRevision,
    })
    .from(activitySessionQueueItems)
    .leftJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
    .leftJoin(generationRequests, queueItemRequestEdge())
    .where(where)
    .orderBy(asc(activitySessionQueueItems.position));
  const rows = await (limit == null ? query : query.limit(limit));
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    state: row.state,
    vibeSwitchSetAside: row.vibeSwitchSetAside,
    trackId: row.trackId,
    track:
      row.trackId && row.trackStatus
        ? {
            id: row.trackId,
            title: row.trackTitle,
            generatedArtistName: row.generatedArtistName,
            status: row.trackStatus,
            durationSeconds: row.durationSeconds,
            coverImageId: row.coverImageId,
            savedAt: row.savedAt,
            favoritedAt: row.favoritedAt,
            dislikedAt: row.dislikedAt,
            inCuratedPlaylist: row.inCuratedPlaylist ?? false,
            genreTags: row.genreTags ?? [],
            vocalMode: row.vocalMode ?? 'instrumental',
            hasLyrics: row.hasLyrics ?? false,
            hasPlayableAudio: row.assetFlags?.playable ?? false,
            hasFinalAsset: row.assetFlags?.final ?? false,
            hasStreamAsset: row.assetFlags?.stream ?? false,
            analysis: {
              analysisStatus: row.analysisStatus ?? 'pending',
              analysisVersion: row.analysisVersion,
              bpmEstimate: row.bpmEstimate,
              bpmSource: row.bpmSource,
              bpmConfidence: row.bpmConfidence,
              headBeatAnchorSeconds: row.headBeatAnchorSeconds,
              headBeatPeriodSeconds: row.headBeatPeriodSeconds,
              tailBeatAnchorSeconds: row.tailBeatAnchorSeconds,
              tailBeatPeriodSeconds: row.tailBeatPeriodSeconds,
              lufsIntegrated: row.lufsIntegrated,
              truePeakDb: row.truePeakDb,
            },
          }
        : null,
    targetBpm: row.targetBpm,
    targetKey: row.targetKey,
    styleRevision: row.styleRevision,
  }));
}

/** The live queue-item states as a parameterized SQL list (from the shared bucket). */
const liveQueueItemStatesSql = sql.join(
  LIVE_QUEUE_ITEM_STATES.map((state) => sql`${state}`),
  sql`, `,
);

/**
 * The position the window is anchored on: the current item, or — with no current
 * item stamped — the first slot a listener has not consumed, which is where
 * playback would begin. A session whose every slot is consumed anchors one past
 * its last, so the window is the tail rather than the whole order: the pointer is
 * null until a `started` report lands, and a poll running every 1–4s must not
 * drag a session's full history in the meantime.
 */
function anchorPosition(sessionId: string, currentQueueItemId: string | null): SQL<number> {
  if (currentQueueItemId) {
    return sql`(select q.position from ${activitySessionQueueItems} q where q.id = ${currentQueueItemId})`;
  }
  return sql`(select coalesce(
      min(q.position) filter (where q.state in (${liveQueueItemStatesSql})),
      max(q.position) + 1
    ) from ${activitySessionQueueItems} q where q.activity_session_id = ${sessionId})`;
}

/** The whole Session: no window start, nothing elided. */
const FULL_READ = { windowStartPosition: null, earlier: 0, earlierTracks: 0 } as const;

/**
 * Where the windowed read starts, and how many slots and playable Tracks fall
 * before it. The edge is ONE query on the hottest poll: over the slots before
 * the anchor, `OFFSET` lands on the exact `PLAYED_WINDOW_SLOTS`-th slot back
 * (positions may have gaps) while `count(*) over ()` — evaluated before
 * OFFSET/LIMIT — counts them all, so the elided tail is the count minus the
 * window. Too little history → full read, and nothing elided to count.
 */
async function resolveQueueWindow(
  db: Database,
  sessionId: string,
  currentQueueItemId: string | null,
): Promise<{ windowStartPosition: number | null; earlier: number; earlierTracks: number }> {
  const [edge] = await db
    .select({
      position: activitySessionQueueItems.position,
      beforeAnchor: sql<number>`count(*) over ()::int`,
    })
    .from(activitySessionQueueItems)
    .leftJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
    .where(
      and(
        eq(activitySessionQueueItems.activitySessionId, sessionId),
        slotStillInSession,
        lt(activitySessionQueueItems.position, anchorPosition(sessionId, currentQueueItemId)),
      ),
    )
    .orderBy(desc(activitySessionQueueItems.position))
    .offset(PLAYED_WINDOW_SLOTS - 1)
    .limit(1);
  if (!edge) return { windowStartPosition: null, earlier: 0, earlierTracks: 0 };
  const [elided] = await db
    .select({ tracks: sql<number>`count(*)::int` })
    .from(activitySessionQueueItems)
    .innerJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
    .where(
      and(
        eq(activitySessionQueueItems.activitySessionId, sessionId),
        slotStillInSession,
        lt(activitySessionQueueItems.position, edge.position),
        slotHasPinnedSource,
      ),
    );
  return {
    windowStartPosition: edge.position,
    earlier: edge.beforeAnchor - PLAYED_WINDOW_SLOTS,
    earlierTracks: elided?.tracks ?? 0,
  };
}

/**
 * The Tracks the session's in-flight provider work still owes, as one scalar
 * column correlated to the `activity_sessions` row being read. A queue slot is
 * born `queued` when a provider track ARRIVES, so no slot state ever says "on
 * the way" — only the jobs do. Each in-flight job (the SHARED
 * `inFlightProviderJobCondition`, minus the parked submits that owe nothing) is
 * expected to yield `tracksPerRequest` Tracks; the slots already attached to its
 * request are subtracted, so a half-delivered call owes only its missing sibling
 * and a fully delivered one owes nothing. The submit path inserts exactly one job
 * per request, so charging a request's arrived slots against its job is exact.
 *
 * A REJECTED slot still counts as arrived: the Track was delivered and paid
 * for, and disliking it must not make the job look like it owes another one.
 * Around provider status edges the figure can be off by a Track in either
 * direction — the clamp keeps it non-negative (the contract's field is), and
 * the segment's job is "roughly how much is coming", not accounting.
 *
 * `scope` narrows which requests count (the live-revision subset).
 */
function generatingTracksColumn(
  db: Database,
  args: { phantomSubmitCutoff: Date; tracksPerRequest: number },
  scope?: SQL,
): SQL<number> {
  // The slot→request edge is the shared one (the slot's own request, else its
  // track's), correlated to the job's request; the session scoping in both
  // halves correlates to the outer `activity_sessions` row.
  const arrivedSlots = db
    .select({ value: count() })
    .from(activitySessionQueueItems)
    .leftJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
    .where(
      and(
        eq(activitySessionQueueItems.activitySessionId, activitySessions.id),
        queueItemRequestEdge(),
      ),
    );
  const owed = sql`greatest(0, ${args.tracksPerRequest}::int - (${arrivedSlots})::int)`;
  const owedAcrossJobs = db
    .select({ value: sql`coalesce(sum(${owed}), 0)::int` })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        eq(generationRequests.activitySessionId, activitySessions.id),
        inFlightProviderJobCondition(args.phantomSubmitCutoff),
        notInArray(providerJobs.normalizedStatus, [...PARKED_SUBMIT_STATUSES]),
        scope,
      ),
    );
  return sql<number>`(${owedAcrossJobs})`;
}

function liveRevisionFillSpentColumn(db: Database): SQL<boolean> {
  const spent = db
    .select({ one: sql`1` })
    .from(generationRequests)
    .where(
      and(
        eq(generationRequests.activitySessionId, activitySessions.id),
        gte(generationRequests.styleRevision, activitySessions.styleRevision),
        ...notUnbilledRefusal(db, true),
      ),
    );
  return sql<boolean>`exists (${spent})`;
}

/**
 * The session's newest provider job (id tie-break for same-timestamp inserts).
 * A submit parked past its in-flight slot (`phantomSubmitCutoff`) is nothing
 * the player can wait on, so it reads as none: the generation status owns it.
 */
async function latestProviderJobState(
  db: Database,
  sessionId: string,
  phantomSubmitCutoff: Date,
): Promise<SessionQueuePendingGeneration | null> {
  const [row] = await db
    .select({
      normalizedStatus: providerJobs.normalizedStatus,
      lastSubmitAttemptAt: providerJobs.lastSubmitAttemptAt,
      createdAt: providerJobs.createdAt,
      updatedAt: providerJobs.updatedAt,
      earlyTrackTitle: generationRequests.earlyTrackTitle,
    })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(eq(generationRequests.activitySessionId, sessionId))
    .orderBy(desc(providerJobs.createdAt), desc(providerJobs.id))
    .limit(1);
  if (!row) return null;
  const phantom = (PHANTOM_SUBMIT_PROVIDER_STATUSES as readonly string[]).includes(
    row.normalizedStatus,
  );
  if (phantom && row.updatedAt.getTime() <= phantomSubmitCutoff.getTime()) return null;
  return {
    normalizedStatus: row.normalizedStatus,
    submittedAt: row.lastSubmitAttemptAt ?? row.createdAt,
    earlyTrackTitle: row.earlyTrackTitle,
  };
}
