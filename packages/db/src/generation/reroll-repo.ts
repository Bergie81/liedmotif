// Sibling-reroll query. On a Dislike,
// the reroll prefers the disliked track's already-generated, UNPLAYED sibling —
// the other Track from the same ProviderJob (N=2 for Suno), a pre-paid same-vibe
// alternate — before spending a fresh music-model call. "Unplayed" = no persisted
// `started` playback event. The query never crosses ProviderJob boundaries and
// never returns a Reject (disliked) sibling.

import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { BlendIdentity, SessionMode } from '@liedmotif/shared';
import type { DbOrTx, Transaction } from '../transactions';
import {
  activitySessions,
  generationRequests,
  playbackEvents,
  tracks,
  type StyleSnapshot,
} from '../schema';

/**
 * Find an unplayed sibling of `dislikedTrackId` (same `providerJobId`, playable —
 * `ready` or `streamable` — not itself disliked, never `started`), or null when none remains. Deterministic
 * (orders by `providerTrackId`) so repeated calls agree.
 */
export async function findUnplayedSibling(
  db: DbOrTx,
  args: { dislikedTrackId: string },
): Promise<string | null> {
  const [disliked] = await db
    .select({ providerJobId: tracks.providerJobId })
    .from(tracks)
    .where(eq(tracks.id, args.dislikedTrackId))
    .limit(1);
  if (!disliked) return null;

  const [sibling] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(
      and(
        eq(tracks.providerJobId, disliked.providerJobId),
        ne(tracks.id, args.dislikedTrackId),
        inArray(tracks.status, ['ready', 'streamable']),
        isNull(tracks.dislikedAt),
        // Unplayed: no persisted `started` event for this track.
        sql`not exists (
          select 1 from ${playbackEvents}
          where ${playbackEvents.trackId} = ${tracks.id}
            and ${playbackEvents.eventType} = 'started'
        )`,
      ),
    )
    .orderBy(tracks.providerTrackId)
    .limit(1);
  return sibling?.id ?? null;
}

// --- Fresh-call reroll identity --------------------------------------------------
//
// When a Dislike chooses a FRESH music-model call (no unplayed sibling), the
// replacement must be generated against the DISLIKED TRACK's request identity —
// its style prompt, revision, and BPM/key targets — never re-derived from the live
// snapshot (a post-Change-Vibe reroll of an old-vibe track would otherwise compile
// the NEW vibe for the OLD track's replacement). The dislike route marks the
// intent (`tracks.reroll_pending_at`); the buffer controller's next `generate`
// consumes the oldest one and copies the identity.

/**
 * Mark a disliked track as awaiting a fresh-call reroll. Owner-scoped and guarded
 * on `dislikedAt` (only a genuinely disliked track can carry the intent). Runs on
 * the caller's executor — the dislike route calls it INSIDE the same transaction
 * that rejects the track, so the queue gap and the reroll intent become visible
 * atomically (a buffer sweep can never see one without the other).
 */
export async function markTrackRerollPending(
  db: DbOrTx,
  args: { ownerUserId: string; trackId: string; now?: Date },
): Promise<{ marked: boolean }> {
  const now = args.now ?? new Date();
  const updated = await db
    .update(tracks)
    .set({ rerollPendingAt: now })
    .where(
      and(
        eq(tracks.id, args.trackId),
        eq(tracks.ownerUserId, args.ownerUserId),
        isNotNull(tracks.dislikedAt),
      ),
    )
    .returning({ id: tracks.id });
  return { marked: updated.length > 0 };
}

/** The identity a fresh-call reroll copies from the disliked track's request. */
export interface RerollIdentity extends BlendIdentity {
  /** The disliked track whose pending intent was consumed. */
  trackId: string;
  /** The ORIGINAL request's compilation context (validated snapshot) — the
   *  canonical reroll path re-runs the normal compiler over it. Null on
   *  legacy rows. */
  styleSnapshot: StyleSnapshot | null;
  /** The ORIGINAL request's session-frozen style (incl. its frozen BPM/key tail). */
  stylePrompt: string | null;
  /** The ORIGINAL request's persisted negative tags (legacy-fallback input). */
  negativePrompt: string | null;
  /** The ORIGINAL request's frozen prompt history — "same prompt" is copied
   *  verbatim, so the replacement's provenance is the disliked Track's, not the
   *  session's current one. Null on legacy rows (never stamped). */
  userPrompt: string | null;
  /** The disliked track's stored prompt identity (last-resort legacy fallback). */
  prompt: string;
  vocalMode: 'instrumental' | 'vocal';
  title: string | null;
}

/**
 * PEEK the session's OLDEST pending fresh-call reroll: the disliked track's
 * request identity for the replacement submit, WITHOUT consuming the intent.
 * Runs inside the buffer tick's owner-lock transaction, so a concurrent tick
 * cannot race the later consume. Peek and consume are split deliberately: the
 * tick must know the reroll's style BEFORE the provider-block comparison (a
 * policy block is tested against the style that would actually submit), and
 * the intent is consumed only when a submit really happens — a tick that
 * decides `wait`/blocked leaves it pending for the next one.
 */
export async function peekPendingRerollIdentity(
  tx: Transaction,
  sessionId: string,
): Promise<RerollIdentity | null> {
  const [pending] = await tx
    .select({
      trackId: tracks.id,
      styleSnapshot: generationRequests.styleSnapshot,
      stylePrompt: generationRequests.stylePrompt,
      negativePrompt: generationRequests.negativePrompt,
      userPrompt: generationRequests.userPrompt,
      styleRevision: generationRequests.styleRevision,
      targetBpm: generationRequests.targetBpm,
      targetKey: generationRequests.targetKey,
      prompt: tracks.prompt,
      vocalMode: tracks.vocalMode,
      title: tracks.title,
    })
    .from(tracks)
    .innerJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .where(
      and(eq(generationRequests.activitySessionId, sessionId), isNotNull(tracks.rerollPendingAt)),
    )
    .orderBy(asc(tracks.rerollPendingAt), asc(tracks.id))
    .limit(1);
  return pending ?? null;
}

/** Consume a peeked reroll intent (same transaction as the submit it feeds). */
export async function consumePendingReroll(tx: Transaction, trackId: string): Promise<void> {
  await tx.update(tracks).set({ rerollPendingAt: null }).where(eq(tracks.id, trackId));
}

/**
 * CANCEL pending fresh-call reroll intents of a session — every one by default
 * (the write behind "Repeat means stop generating, not defer"), or with `belowStyleRevision` only those whose request
 * predates that Style Snapshot revision (a Change Vibe since: old-vibe rerolls
 * buy nothing). The buffer tick that calls this
 * owns the policy. Sweeping the session in one statement is what makes the
 * cancellation total: it covers a Dislike that preceded the mode switch or the
 * Change Vibe, one that raced it, and any row left over from an install that
 * predates the rule. A request with no recorded revision (pre-blend-identity)
 * is never below one.
 */
export async function clearPendingRerolls(
  tx: Transaction,
  sessionId: string,
  scope: { belowStyleRevision?: number } = {},
): Promise<void> {
  await tx
    .update(tracks)
    .set({ rerollPendingAt: null })
    .where(
      and(
        isNotNull(tracks.rerollPendingAt),
        inArray(
          tracks.generationRequestId,
          tx
            .select({ id: generationRequests.id })
            .from(generationRequests)
            .where(
              and(
                eq(generationRequests.activitySessionId, sessionId),
                scope.belowStyleRevision !== undefined
                  ? lt(generationRequests.styleRevision, scope.belowStyleRevision)
                  : undefined,
              ),
            ),
        ),
      ),
    );
}

/**
 * What governs a Track's reroll (track → request → session): the Session's
 * mode, and whether the Track's request predates the Session's live Style
 * Snapshot revision (`vibeSuperseded` — a Change Vibe since; a request with no
 * recorded revision is never superseded). Null when the Track has no session
 * (a standalone request, or a row whose session was deleted). Takes a
 * `DbOrTx` so a caller that gates a write on it can read it inside the same
 * transaction it commits.
 */
export async function getTrackRerollContext(
  db: DbOrTx,
  args: { trackId: string },
): Promise<{ sessionMode: SessionMode; vibeSuperseded: boolean } | null> {
  const [row] = await db
    .select({
      sessionMode: activitySessions.sessionMode,
      vibeSuperseded: sql<boolean>`coalesce(${lt(generationRequests.styleRevision, activitySessions.styleRevision)}, false)`,
    })
    .from(tracks)
    .innerJoin(generationRequests, eq(tracks.generationRequestId, generationRequests.id))
    .innerJoin(activitySessions, eq(generationRequests.activitySessionId, activitySessions.id))
    .where(eq(tracks.id, args.trackId))
    .limit(1);
  return row ?? null;
}
