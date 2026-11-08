import { sql } from 'drizzle-orm';
import { EMPTY_SESSION_TRACK_ACTIVITY, type SessionTrackActivity } from '@liedmotif/shared';
import type { Database } from '../client';
import { activitySessionQueueItems, generationRequests, tracks } from '../schema';
import { playableSessionTrackCondition, sessionTrackQueueEdge } from './session-track-playability';

export type { SessionTrackActivity } from '@liedmotif/shared';

interface SessionTrackActivityRow extends SessionTrackActivity, Record<string, unknown> {
  sessionId: string;
}

/**
 * Summarize playable, non-disliked Tracks for a bounded set of owned Sessions.
 * Postgres performs the aggregation so Track history never grows the web
 * process's working set.
 */
export async function getSessionTrackActivities(
  db: Database,
  args: { ownerUserId: string; sessionIds: string[] },
): Promise<Map<string, SessionTrackActivity>> {
  if (args.sessionIds.length === 0) return new Map();
  const sessionIds = sql.join(
    args.sessionIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<SessionTrackActivityRow>(sql`
    with listed_tracks as (
      select distinct
        ${generationRequests.activitySessionId} as session_id,
        ${tracks.id} as track_id,
        ${tracks.createdAt} as created_at,
        ${tracks.durationSeconds} as duration_seconds,
        ${tracks.genreTags} as genre_tags
      from ${generationRequests}
      inner join ${tracks}
        on ${tracks.generationRequestId} = ${generationRequests.id}
      left join ${activitySessionQueueItems} on ${sessionTrackQueueEdge}
      where ${generationRequests.activitySessionId} in (${sessionIds})
        and ${generationRequests.ownerUserId} = ${args.ownerUserId}
        and ${playableSessionTrackCondition(args.ownerUserId)}
    ),
    track_totals as (
      select
        session_id,
        count(*)::int as track_count,
        -- As in a Playlist, a Track of unknown length counts 0: sum skips it.
        coalesce(sum(duration_seconds), 0)::double precision as total_duration_seconds
      from listed_tracks
      group by session_id
    ),
    -- Distinct so a Track that repeats a genre counts it once.
    track_tags as (
      select distinct session_id, track_id, created_at, lower(btrim(tags.tag)) as tag
      from listed_tracks, jsonb_array_elements_text(genre_tags) as tags(tag)
    ),
    ranked_tags as (
      select
        session_id,
        tag,
        row_number() over (
          partition by session_id
          order by count(*) desc, min(created_at), tag
        ) as tag_rank
      from track_tags
      where tag <> ''
      group by session_id, tag
    ),
    genre_tags as (
      select
        session_id,
        jsonb_agg(tag order by tag_rank) filter (where tag_rank <= 3) as tags
      from ranked_tags
      group by session_id
    )
    select
      track_totals.session_id as "sessionId",
      track_totals.track_count as "trackCount",
      track_totals.total_duration_seconds as "totalDurationSeconds",
      coalesce(genre_tags.tags, '[]'::jsonb) as "genreTags"
    from track_totals
    left join genre_tags using (session_id)
  `);

  return new Map(
    result.rows.map(({ sessionId, trackCount, totalDurationSeconds, genreTags }) => [
      sessionId,
      { trackCount, totalDurationSeconds, genreTags },
    ]),
  );
}

export async function getSessionTrackActivity(
  db: Database,
  args: { ownerUserId: string; sessionId: string },
): Promise<SessionTrackActivity> {
  const activities = await getSessionTrackActivities(db, {
    ownerUserId: args.ownerUserId,
    sessionIds: [args.sessionId],
  });
  return activities.get(args.sessionId) ?? EMPTY_SESSION_TRACK_ACTIVITY;
}
