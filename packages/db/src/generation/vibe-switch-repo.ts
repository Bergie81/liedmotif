// Switch-now Change Vibe cutover. While
// a session's `vibeSwitchRevision` is armed, the first PLAYABLE track at/above
// that revision triggers a one-shot pass: every still-`queued` older-revision
// item is set aside as `skipped` — the paid tracks stay in the session and the
// Library, and NO feedback event is written (the listener never heard them, so
// this is not a Skip signal) — and the switch clears. The currently `playing`
// item is never touched; the player crossfades off it when the post-cutover
// queue arrives. Old-vibe material materializing AFTER the pass stays queued
// (the cutover is one-shot by design; the switch is already spent).

import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { withTransaction } from '../transactions';
import { queueItemRequestEdge } from './queue-request-edge';
import {
  activitySessions,
  activitySessionQueueItems,
  generationRequests,
  tracks,
  trackAudioAssets,
} from '../schema';

/** A servable audio asset exists — the same floor the queue view's pinned
 *  asset paths use (a flagged-playable row with neither source is unservable). */
const playableAssetExists = sql<boolean>`exists (
  select 1 from ${trackAudioAssets}
  where ${trackAudioAssets.trackId} = ${tracks.id}
    and ${trackAudioAssets.isPlayable} = true
    and (${trackAudioAssets.storageKey} is not null
      or ${trackAudioAssets.encryptedSourceUrl} is not null)
)`;

/**
 * Run the cutover for one session if it is due. Serialized on the session row
 * lock so a concurrent pass (poll + recovery task) cannot double-run; the
 * skip-marking and the switch clear commit atomically.
 */
export async function performVibeSwitchCutover(
  db: Database,
  sessionId: string,
): Promise<{ cutOver: boolean }> {
  // Lock-free probe first: no switch is armed on the vast majority of calls
  // (every materializing poll passes through here), and taking the session row
  // lock just to discover that contends with the buffer tick and playback
  // reports. Only an armed switch pays for the locked re-read below.
  const [probe] = await db
    .select({ vibeSwitchRevision: activitySessions.vibeSwitchRevision })
    .from(activitySessions)
    .where(eq(activitySessions.id, sessionId))
    .limit(1);
  if (probe?.vibeSwitchRevision == null) return { cutOver: false };

  return withTransaction(db, async (tx) => {
    const [session] = await tx
      .select({ vibeSwitchRevision: activitySessions.vibeSwitchRevision })
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId))
      .limit(1)
      .for('no key update');
    const switchRevision = session?.vibeSwitchRevision;
    if (switchRevision == null) return { cutOver: false };

    const requestEdge = queueItemRequestEdge();

    // Due only once a new-vibe track can actually be heard — cutting over to
    // silence would interrupt the music the toggle promises to keep playing.
    const [target] = await tx
      .select({ id: activitySessionQueueItems.id })
      .from(activitySessionQueueItems)
      .innerJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
      .leftJoin(generationRequests, requestEdge)
      .where(
        and(
          eq(activitySessionQueueItems.activitySessionId, sessionId),
          eq(activitySessionQueueItems.state, 'queued'),
          gte(generationRequests.styleRevision, switchRevision),
          playableAssetExists,
        ),
      )
      .limit(1);
    if (!target) return { cutOver: false };

    const oldVibeQueuedItems = tx
      .select({ id: activitySessionQueueItems.id })
      .from(activitySessionQueueItems)
      .leftJoin(tracks, eq(activitySessionQueueItems.trackId, tracks.id))
      .leftJoin(generationRequests, requestEdge)
      .where(
        and(
          eq(activitySessionQueueItems.activitySessionId, sessionId),
          eq(activitySessionQueueItems.state, 'queued'),
          or(
            isNull(generationRequests.styleRevision),
            lt(generationRequests.styleRevision, switchRevision),
          ),
        ),
      );
    await tx
      .update(activitySessionQueueItems)
      .set({ state: 'skipped', vibeSwitchSetAside: true })
      .where(inArray(activitySessionQueueItems.id, oldVibeQueuedItems));

    await tx
      .update(activitySessions)
      .set({ vibeSwitchRevision: null })
      .where(eq(activitySessions.id, sessionId));
    return { cutOver: true };
  });
}
