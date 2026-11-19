import { and, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { phantomSubmitCutoffAt } from '@liedmotif/shared';
import type { DbOrTx } from '../transactions';
import {
  activitySessions,
  activitySessionQueueItems,
  generationOutputs,
  generationRequests,
  providerJobs,
  tracks,
  trackAudioAssets,
} from '../schema';
import { READY_MISSING_TRACKS_RECENCY_MS } from './provider-poll-repo';
import { playableSessionTrackCondition, sessionTrackQueueEdge } from './session-track-playability';

const unknownTrackDuration = sql`(${tracks.durationSeconds} is null or ${tracks.durationSeconds} <= 0)`;

/** The final-audio download gave up: no local file will land unless something re-enqueues it. */
function givenUpFinalDownload(trackId: SQL): SQL {
  return sql`exists (select 1 from ${generationOutputs} o
    where o.track_id = ${trackId} and o.storage_failed_at is not null)`;
}

/**
 * A stream-only Track whose final will never be stored: its provider job ended
 * without completing (a failure or poll timeout after the stream stage), or its
 * final download gave up. No local file exists to measure, so its duration may
 * never become known. It counts as zero seconds rather than an unknown that
 * would hold the Session below its target for good; a salvaged final or a
 * re-enqueued download makes it measurable again.
 */
const unmeasurableStreamOnlyTrack = sql`(
  (exists (select 1 from ${providerJobs} j
    where j.id = ${tracks.providerJobId}
      and j.normalized_status in ('failed_final', 'blocked_by_provider_credits', 'blocked_by_policy'))
  and not exists (select 1 from ${trackAudioAssets} a
    where a.track_id = ${tracks.id} and a.asset_type in ('provider_final', 'local_original')))
  or ${givenUpFinalDownload(sql`${tracks.id}`)}
)`;

/** Correlated scalar fields keep every Session summary on the same accounting as admission. */
export function sessionDurationColumns(sessionId: SQL, ownerUserId: SQL) {
  const usable = and(
    eq(generationRequests.activitySessionId, sessionId),
    playableSessionTrackCondition(ownerUserId),
  );
  const source = sql`from ${tracks}
    inner join ${generationRequests} on ${generationRequests.id} = ${tracks.generationRequestId}
    left join ${activitySessionQueueItems} on ${sessionTrackQueueEdge}
    where ${usable}`;
  return {
    generatedDurationSeconds:
      sql<number>`(select coalesce(sum(case when ${tracks.durationSeconds} > 0 then ${tracks.durationSeconds} else 0 end), 0) ${source})`.mapWith(
        Number,
      ),
    unknownDurationTrackCount:
      sql<number>`(select count(*) ${source} and ${unknownTrackDuration} and not ${unmeasurableStreamOnlyTrack})`.mapWith(
        Number,
      ),
  };
}

export async function getSessionDurationProgress(
  db: DbOrTx,
  args: { ownerUserId: string; sessionId: string; now?: Date; phantomSubmitCutoff?: Date },
): Promise<{
  generatedDurationSeconds: number;
  unknownDurationTrackCount: number;
  batchOutstanding: boolean;
}> {
  const sessionId = sql`${args.sessionId}::uuid`;
  const now = args.now ?? new Date();
  const [row] = await db
    .select({
      ...sessionDurationColumns(sessionId, sql`${args.ownerUserId}`),
      batchOutstanding: outstandingSessionDurationBatch(sessionId, {
        phantomSubmitCutoff: args.phantomSubmitCutoff ?? phantomSubmitCutoffAt(now),
        readyRecoveryCutoff: new Date(now.getTime() - READY_MISSING_TRACKS_RECENCY_MS),
      }),
    })
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    );
  return (
    row ?? { generatedDurationSeconds: 0, unknownDurationTrackCount: 0, batchOutstanding: false }
  );
}

/** Read with the duration total in one SQL snapshot: completing work cannot release
 * its blocker before its usable duration is visible to the same admission. A submit
 * that never captured a task id can never produce Tracks, so it stops holding the
 * batch open at the same phantom-submit cutoff that frees its concurrency slot.
 * A ready batch still settling holds it only while the ready-missing-tracks
 * recovery retries it (`readyRecoveryCutoff`): a settle that never lands would
 * otherwise stall purchases for the Session's whole life.
 * A pending final download holds the batch only while it is what the accounting
 * waits on: a Track already counted from its stream changes nothing when its final
 * lands, and a given-up download will never land, so neither may stall purchases. */
function outstandingSessionDurationBatch(
  sessionId: SQL,
  cutoffs: { phantomSubmitCutoff: Date; readyRecoveryCutoff: Date },
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from provider_jobs j
    inner join generation_requests r on r.id = j.generation_request_id
    where r.activity_session_id = ${sessionId} and (
      (j.submit_state in ('submitting', 'submit_unknown')
        and j.updated_at > ${cutoffs.phantomSubmitCutoff.toISOString()}::timestamptz)
      or j.normalized_status in ('submitted', 'processing', 'partially_ready')
      or (j.normalized_status = 'ready'
        and j.updated_at >= ${cutoffs.readyRecoveryCutoff.toISOString()}::timestamptz
        and (
          r.status = 'awaiting_results'
          or (r.status <> 'materialized' and
            (select count(*) from tracks t where t.provider_job_id = j.id) < r.requested_track_count)
        ))
      or exists (select 1 from tracks t where t.provider_job_id = j.id and t.status = 'pending')
      or exists (
        select 1 from tracks t
        where t.provider_job_id = j.id and t.status in ('streamable', 'ready')
          and t.disliked_at is null
          and exists (select 1 from track_audio_assets a
            where a.track_id = t.id and a.asset_type = 'provider_final'
              and a.encrypted_source_url is not null)
          and not exists (select 1 from track_audio_assets a
            where a.track_id = t.id and a.asset_type = 'local_original'
              and a.storage_key is not null)
          and not ${givenUpFinalDownload(sql`t.id`)}
          and not (t.duration_seconds > 0 and exists (select 1 from track_audio_assets a
            where a.track_id = t.id and a.asset_type = 'provider_stream' and a.is_playable
              and a.encrypted_source_url is not null))
      )
    )
  )`;
}

/** Settle the full paid batch only after every result in its final response has been handled. */
export async function markSessionDurationBatchMaterialized(
  db: DbOrTx,
  requestId: string,
): Promise<void> {
  await db
    .update(generationRequests)
    .set({ status: 'materialized' })
    .where(
      and(eq(generationRequests.id, requestId), ne(generationRequests.status, 'materialized')),
    );
}

/** Measurement enriches playable audio without reviving a rejected or deleted Track. */
export async function writeMeasuredTrackDuration(
  db: DbOrTx,
  trackId: string,
  seconds: number,
): Promise<void> {
  const durationSeconds = Math.floor(seconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
  await db
    .update(tracks)
    .set({ durationSeconds })
    .where(
      and(
        eq(tracks.id, trackId),
        inArray(tracks.status, ['ready', 'streamable']),
        unknownTrackDuration,
      ),
    );
}

/** Repair only local audio whose missing duration can block an active limited Session. */
export async function listSessionTracksMissingDuration(
  db: DbOrTx,
  limit: number,
): Promise<{ trackId: string; storageKey: string }[]> {
  const rows = await db
    .select({ trackId: tracks.id, storageKey: trackAudioAssets.storageKey })
    .from(activitySessions)
    .innerJoin(generationRequests, eq(generationRequests.activitySessionId, activitySessions.id))
    .innerJoin(tracks, eq(tracks.generationRequestId, generationRequests.id))
    .leftJoin(activitySessionQueueItems, sessionTrackQueueEdge)
    .innerJoin(
      trackAudioAssets,
      and(
        eq(trackAudioAssets.trackId, tracks.id),
        eq(trackAudioAssets.assetType, 'local_original'),
        eq(trackAudioAssets.isPlayable, true),
      ),
    )
    .where(
      and(
        eq(activitySessions.status, 'active'),
        isNotNull(activitySessions.targetDurationMinutes),
        unknownTrackDuration,
        playableSessionTrackCondition(sql`${activitySessions.ownerUserId}`),
      ),
    )
    // Unreadable audio must not monopolize every bounded retry batch.
    .orderBy(sql`random()`)
    .limit(limit);
  return rows.flatMap((row) =>
    row.storageKey ? [{ trackId: row.trackId, storageKey: row.storageKey }] : [],
  );
}
