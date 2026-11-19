// `POST /api/tracks/dislike` → dislikeTrack (Dislike = REROLL + reject).
//
// On the first Dislike of an owned track this:
//   1. rejects it (hidden now, deleted ~24h) through the EXISTING eviction mechanism —
//      `rejectDislikedTrack` flips it to the Reject retention class, removes it from the
//      queue, drops its audio, and queues the ~24h purge (it does NOT hand-roll deletion);
//   2. writes a `dislike` audit row;
//   3. REPORTS the sibling-first reroll: a pre-paid sibling still queued in the
//      Session ($0) beats a fresh call beats nothing. The route NEVER spends — removing the track shortens the
//      session buffer, and the worker buffer controller performs the actual top-up
//      through its EXISTING cost gate (so usage limits still apply; no second spend path).
// The fresh-call branch is `keep_going`-only: a Session set to "Play existing Tracks"
// loses the disliked Track and buys nothing. It also never buys a vibe the Session
// has left: a Track whose request predates the live Style Snapshot revision loses
// its place, and only a pre-paid sibling can stand in for it. A Stopped Session
// buys nothing either: Resume cancels pending intents, so one recorded now
// could only ever be dropped.
// Dislike NEVER steers future generation. Idempotent: a second Dislike is a no-op.

import { NextResponse } from 'next/server';
import {
  findUnplayedSibling,
  getTrackRerollContext,
  markTrackRerollPending,
  rejectDislikedTrackInTx,
  withTransaction,
} from '@liedmotif/db';
import {
  dislikeTrackRequestSchema,
  selectRerollReplacement,
  type RerollReplacement,
} from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { ownerHasGenerationBudget } from '@/lib/sessions/sessions';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    dislikeTrackRequestSchema,
    'Invalid dislike request.',
  );
  if (parsed instanceof NextResponse) return parsed;
  const { trackId } = parsed;

  const db = getDb();
  // The cost-gate READ used only to pick `generation` vs `none` (never a spend —
  // the worker performs the top-up through the same gate). Advisory, so it stays
  // outside the transaction below.
  const canGenerate = await ownerHasGenerationBudget(db, ownerUserId);

  // Reject, resolve the reroll replacement, and record the fresh-call intent in
  // ONE transaction: a buffer sweep can never see the queue gap without the
  // intent (which would compile the LIVE snapshot for an old-vibe track's
  // replacement), and a crash mid-dislike never strands a rejected track whose
  // idempotent retry would record no intent.
  const outcome = await withTransaction(db, async (tx) => {
    const rejected = await rejectDislikedTrackInTx(tx, { ownerUserId, trackId });
    if (!rejected) return null;
    // Already disliked → idempotent no-op: no second reject, no second reroll.
    if (rejected.alreadyDisliked) {
      return { rejected, replacement: { source: 'none' } as RerollReplacement };
    }

    // The status, mode and live revision are read INSIDE this transaction so
    // the gate, the reject, and the intent write all commit against one state —
    // a concurrent switch to Repeat, Change Vibe or Stop either loses to this
    // dislike or is swept up by the worker's (or Resume's) cancellation.
    // A Track with no Session at all (a Library survivor of a deleted one), or
    // one whose Session is Stopped, reads as `repeat`: no buffer tick runs for
    // it, and Resume drops pending intents, so reporting `generation` there
    // would promise a replacement that can never arrive.
    const context = await getTrackRerollContext(tx, { trackId });
    const unplayedSiblingId = await findUnplayedSibling(tx, { dislikedTrackId: trackId });
    const replacement = selectRerollReplacement({
      sessionMode: context?.sessionStatus === 'active' ? context.sessionMode : 'repeat',
      vibeSuperseded: context?.vibeSuperseded ?? false,
      unplayedSiblingId,
      canGenerate,
    });

    // A FRESH-CALL reroll must be generated against the disliked track's request
    // identity, never the live snapshot — record
    // the intent on the track; the worker's next generate consumes it and copies
    // the identity. Sibling rerolls are pre-paid tracks of the SAME request, so
    // they carry the right identity by construction and need no mark.
    if (replacement.source === 'generation') {
      await markTrackRerollPending(tx, { ownerUserId, trackId });
    }
    return { rejected, replacement };
  });
  if (!outcome) return apiError('not_found', 'Track not found.');

  return apiOk({
    trackId,
    dislikedAt: outcome.rejected.dislikedAt.toISOString(),
    rerollQueued: outcome.replacement.source !== 'none',
    replacementSource: outcome.replacement.source,
  });
}
