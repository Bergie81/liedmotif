// `GET /api/tracks/[trackId]/lyrics` → one readable track's lyric view (the
// player's sleeve-back panel and Lyrics sheet). Scoped owner-or-Lounge-audible
// in the repo query: a malformed, unknown, or unreadable id is the
// same 404, and only lyric text/lines ever reach the client — never task ids
// or provider URLs.
//
// Lazy enrichment, both server-side through the music provider. A `?cached` read
// serves what is stored and never reaches the provider (no writes, no spend):
//  - PLAIN lyrics, owner only: a vocal track can lack them even though its job
//    completed; re-read the free status poll and persist. In-flight jobs are
//    excluded — the worker is already polling those, so the words arrive on
//    their own and this route just reports `pending`.
//  - WORD TIMING, any reader (Visitors see synced lyrics): fetched
//    once per track (the call costs provider credits) and cached forever, on
//    the owner's ledger whoever opened it; a provider "no timing" answer is
//    cached too, as an empty word list, so the call is never repeated. Provider
//    failures degrade to the unsynced view and leave nothing behind, so a later
//    open retries. Never budget-gated or counted: the charge is an ancillary
//    cost of a vocal Track already admitted under its budget.

import { NextResponse } from 'next/server';
import {
  getReadableTrackLyricsContext,
  recordUsageEvent,
  saveTrackLyrics,
  saveTrackTimedLyrics,
  type ReadableTrackLyricsContext,
} from '@liedmotif/db';
import { buildLyricLines, uuidSchema, type TimedLyrics, type TrackLyrics } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, requireOwnerId } from '@/lib/api-response';
import { getMusicProvider } from '@/lib/providers';
import { enqueueEmbedTrackMetadataBatch } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

/** The provider only answers for the SAME provider the track came from. */
async function providerFor(ctx: ReadableTrackLyricsContext) {
  const provider = await getMusicProvider();
  return provider.providerKey === ctx.providerKey ? provider : null;
}

/** Backfill plain lyrics from the free status poll; null when nothing usable.
 *  Runs only for a vocal track whose lyrics column is still null. */
async function backfillPlainLyrics(ctx: ReadableTrackLyricsContext): Promise<string | null> {
  try {
    const provider = await providerFor(ctx);
    if (!provider || !ctx.providerTaskId) return null;
    const status = await provider.getGenerationStatus(ctx.providerTaskId);
    const lyrics = status.tracks.find((t) => t.providerTrackId === ctx.providerTrackId)?.lyrics;
    if (!lyrics) return null;
    await saveTrackLyrics(getDb(), { trackId: ctx.trackId, lyrics });
    // The local MP3 was tagged before the words existed — retag it so shared
    // files carry the lyrics (`USLT`). Best-effort by contract, never throws.
    await enqueueEmbedTrackMetadataBatch(getDb(), [ctx.trackId]);
    return lyrics;
  } catch {
    // Sanitized provider failure — degrade to "no lyrics yet"; a later open retries.
    return null;
  }
}

/**
 * Concurrent opens of the same track's lyrics (the sleeve panel plus the
 * expanded sheet) must not each pay for a timing fetch: the second caller
 * awaits the first call's promise instead. Per-process, which is exactly the
 * scope where the DB write-once guard cannot help.
 */
const inFlightTimedFetches = new Map<string, Promise<TimedLyrics | null>>();

function fetchTimedLyricsOnce(ctx: ReadableTrackLyricsContext): Promise<TimedLyrics | null> {
  const inFlight = inFlightTimedFetches.get(ctx.trackId);
  if (inFlight) return inFlight;
  const fetch = fetchTimedLyrics(ctx).finally(() => inFlightTimedFetches.delete(ctx.trackId));
  inFlightTimedFetches.set(ctx.trackId, fetch);
  return fetch;
}

/** Fetch-and-cache word timing; null on failure (nothing persisted → retryable). */
async function fetchTimedLyrics(ctx: ReadableTrackLyricsContext): Promise<TimedLyrics | null> {
  try {
    const provider = await providerFor(ctx);
    if (!provider?.getTimestampedLyrics || !ctx.providerTaskId) return null;
    const timed = await provider.getTimestampedLyrics({
      providerTaskId: ctx.providerTaskId,
      providerTrackId: ctx.providerTrackId,
    });
    // "No timing exists" is an answer worth caching (words: []) — never re-pay for it.
    const persisted = timed ?? { words: [], alignmentErrorScore: null };
    await saveTrackTimedLyrics(getDb(), { trackId: ctx.trackId, timedLyrics: persisted });
    // Spend ledger is diagnostics-only and best-effort (usage-repo contract).
    try {
      await recordUsageEvent(getDb(), {
        userId: ctx.ownerUserId,
        providerType: 'music',
        providerKey: ctx.providerKey,
        operation: 'timestamped_lyrics',
        units: 1,
      });
    } catch {
      /* a failed diagnostic write never fails the read */
    }
    return persisted;
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const { trackId } = await params;
  if (!uuidSchema.safeParse(trackId).success) return apiError('not_found', 'Track not found.');

  const ctx = await getReadableTrackLyricsContext(getDb(), { viewerUserId, trackId });
  if (!ctx) return apiError('not_found', 'Track not found.');

  if (ctx.vocalMode !== 'vocal') {
    return apiOk<TrackLyrics>({ state: 'instrumental', lines: [], synced: false, settled: true });
  }

  const jobComplete = ctx.providerJobStatus === 'ready';
  const jobSettled = jobComplete || ctx.providerJobStatus === 'failed_final';
  // Only a COMPLETE job is enriched here, and a `?cached` read never is: an
  // offline sync copies every vocal Track it stores and must not buy timing for
  // Tracks nobody opened.
  const cachedOnly = new URL(request.url).searchParams.has('cached');
  const canEnrich = jobComplete && !cachedOnly;
  const isOwner = ctx.ownerUserId === viewerUserId;

  const lyrics = ctx.lyrics ?? (canEnrich && isOwner ? await backfillPlainLyrics(ctx) : null);
  if (!lyrics) {
    return apiOk<TrackLyrics>({
      state: jobSettled ? 'ready' : 'pending',
      lines: [],
      synced: false,
      settled: jobSettled,
    });
  }

  const timed = ctx.timedLyrics ?? (canEnrich ? await fetchTimedLyricsOnce(ctx) : null);
  const { lines, synced } = buildLyricLines(lyrics, timed && timed.words.length > 0 ? timed : null);
  // Unsynced words on a still-rendering job WILL gain timing once it completes
  // — tell the client to keep asking instead of settling for the plain view.
  return apiOk<TrackLyrics>({ state: 'ready', lines, synced, settled: synced || jobSettled });
}
