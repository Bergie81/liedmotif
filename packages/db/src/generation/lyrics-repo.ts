// Track lyrics reads/writes. The lyrics route is the only consumer: it reads
// one track's lyric state (with the provider coordinates needed for a lazy
// backfill / timing fetch) and persists what the provider returns —
// write-once, so an idempotent re-request never rewrites captured words. The
// read is scoped owner-or-Lounge-audible; the write paths stay
// keyed by trackId under the route's owner-gated enrichment.

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { ProviderNormalizedStatus, TimedLyrics, VocalMode } from '@liedmotif/shared';
import type { Database } from '../client';
import { viewerCanReadTrack } from '../playlists/lounge-audible';
import { providerJobs, tracks } from '../schema';

/** The summaries' `hasLyrics` projection: presence only — the text is large
 *  and rides its own on-demand route, never a summary read. */
export function trackHasLyricsColumn(): SQL<boolean> {
  return sql<boolean>`${tracks.lyrics} is not null`;
}

export interface ReadableTrackLyricsContext {
  trackId: string;
  /** The track's owner — the route's enrichment gate: provider backfill and the
   *  paid timing fetch run only when the viewer IS the owner. */
  ownerUserId: string;
  vocalMode: VocalMode;
  lyrics: string | null;
  timedLyrics: TimedLyrics | null;
  providerKey: string;
  /** The provider's own track id (`audioId` for the timing endpoint). */
  providerTrackId: string;
  /** The provider job's task id; null until a submit confirmed. */
  providerTaskId: string | null;
  providerJobStatus: ProviderNormalizedStatus;
}

/** One readable track's lyric state; null when missing/unreadable (uniform 404). */
export async function getReadableTrackLyricsContext(
  db: Database,
  args: { viewerUserId: string; trackId: string },
): Promise<ReadableTrackLyricsContext | null> {
  const [row] = await db
    .select({
      trackId: tracks.id,
      ownerUserId: tracks.ownerUserId,
      vocalMode: tracks.vocalMode,
      lyrics: tracks.lyrics,
      timedLyrics: tracks.timedLyrics,
      providerKey: tracks.providerKey,
      providerTrackId: tracks.providerTrackId,
      providerTaskId: providerJobs.providerTaskId,
      providerJobStatus: providerJobs.normalizedStatus,
    })
    .from(tracks)
    .innerJoin(providerJobs, eq(tracks.providerJobId, providerJobs.id))
    .where(and(eq(tracks.id, args.trackId), viewerCanReadTrack(args.viewerUserId)))
    .limit(1);
  return row ?? null;
}

/** Persist backfilled lyric text, write-once (never rewrites captured words). */
export async function saveTrackLyrics(
  db: Database,
  args: { trackId: string; lyrics: string },
): Promise<void> {
  await db
    .update(tracks)
    .set({ lyrics: args.lyrics })
    .where(and(eq(tracks.id, args.trackId), isNull(tracks.lyrics)));
}

/**
 * Persist fetched word timing, write-once. An EMPTY `words` array is a valid
 * value: it records "the provider has no timing for this track" so the paid
 * fetch is never repeated.
 */
export async function saveTrackTimedLyrics(
  db: Database,
  args: { trackId: string; timedLyrics: TimedLyrics },
): Promise<void> {
  await db
    .update(tracks)
    .set({ timedLyrics: args.timedLyrics })
    .where(and(eq(tracks.id, args.trackId), isNull(tracks.timedLyrics)));
}
