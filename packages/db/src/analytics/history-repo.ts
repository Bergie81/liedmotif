// The privacy rules of personal analytics: what removing music
// forgets, and what clearing listening history removes.
//
// Neither is feedback: nothing here writes a feedback event, touches a Session,
// or reads runtime playback state.

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import {
  generationOutputs,
  listeningOccurrences,
  listeningPreferences,
  tracks,
  user,
  userSettings,
  USER_SETTINGS_KEYS,
} from '../schema';
import { withTransaction, type Transaction } from '../transactions';
import { resetLearnedTasteInTx } from './taste-repo';

/**
 * Forget which Tracks the analytics of `scope` (a condition over `tracks`)
 * belonged to. Removed music usually stays behind as a tombstone row, so the
 * foreign keys' ON DELETE never fires for it. Timestamps, totals, musical facts
 * and the opaque `analytics_track_id` stay, which keeps every count and the
 * distinct-Track total intact while nothing can resolve or name the Track.
 */
export async function severTrackAnalyticsLinks(tx: Transaction, scope: SQL): Promise<void> {
  const removed = sql`(select ${tracks.id} from ${tracks} where ${scope})`;
  await tx.execute(sql`
    update ${listeningOccurrences} set track_id = null, session_id = null
    where track_id in ${removed}
  `);
  await tx.execute(sql`
    update ${generationOutputs} set track_id = null where track_id in ${removed}
  `);
  // A tombstone keeps its title and prompt, so it takes a fresh identity: the
  // one its analytics rows carry then matches no row anywhere.
  await tx.execute(sql`update ${tracks} set analytics_id = gen_random_uuid() where ${scope}`);
  // The cached stats answer names its most-played Tracks, and severing moves
  // neither the occurrence count nor the newest instant its key is built from.
  await tx.execute(sql`
    delete from ${userSettings}
    where ${userSettings.key} = ${USER_SETTINGS_KEYS.listeningStats}
      and ${userSettings.ownerUserId} in (select ${tracks.ownerUserId} from ${tracks} where ${scope})
  `);
}

/**
 * Remove the owner's listening records and what is derived from them, learned
 * taste included, which restarts as after Reset learned taste. Music,
 * the generated-output ledger and spend accounting are not listening and stay.
 *
 * Coverage restarts at `now`: output generated earlier may have been heard, so
 * it reads as unknown rather than never heard. The preferences row is the lock
 * `recordListening` shares, so a report in flight either lands before the
 * delete below or sees `history_cleared_at` and is refused.
 */
export async function clearListeningHistory(
  db: Database,
  input: { ownerUserId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await withTransaction(db, async (tx) => {
    await tx.execute(sql`
      insert into ${listeningPreferences} (owner_user_id, collection_started_at, history_cleared_at)
      select ${user.id}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
      from ${user} where ${user.id} = ${input.ownerUserId}
      on conflict (owner_user_id) do update
        set collection_started_at = excluded.collection_started_at,
            history_cleared_at = excluded.history_cleared_at
    `);
    await resetLearnedTasteInTx(tx, { ownerUserId: input.ownerUserId, now });
    await tx
      .delete(listeningOccurrences)
      .where(eq(listeningOccurrences.ownerUserId, input.ownerUserId));
    await tx
      .delete(userSettings)
      .where(
        and(
          eq(userSettings.ownerUserId, input.ownerUserId),
          eq(userSettings.key, USER_SETTINGS_KEYS.listeningStats),
        ),
      );
  });
}
