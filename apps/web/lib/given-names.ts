// A Rename (server-only): the owner's own text replaces a Session's or a
// Track's name, and the tags of the files already downloaded follow it. The
// rename routes and the Assistant both rename through here, so a rename has
// the same effect from either.

import {
  listFinalMp3TrackIdsForSession,
  renameSession,
  renameTrack,
  type Database,
  type SessionRecord,
} from '@liedmotif/db';
import { enqueueEmbedTrackMetadataBatch } from './worker-jobs';

/**
 * Gives the owner's Session a Given Name; null when it is absent or not
 * theirs. Every downloaded Track of it retags its album tag in the background;
 * storage keys and the Session Cover stay as they are.
 */
export async function giveSessionName(
  db: Database,
  args: { ownerUserId: string; sessionId: string; title: string },
): Promise<SessionRecord | null> {
  const session = await renameSession(db, args);
  if (!session) return null;
  const trackIds = await listFinalMp3TrackIdsForSession(db, session.id);
  await enqueueEmbedTrackMetadataBatch(db, trackIds);
  return session;
}

/**
 * Gives the owner's Track a Given Name; null when it is absent or not theirs.
 * The retag is asked for unconditionally: the embed job does nothing for a
 * Track without a downloaded file, and never touches its storage key.
 */
export async function giveTrackName(
  db: Database,
  args: { ownerUserId: string; trackId: string; title: string },
): Promise<{ trackId: string; title: string } | null> {
  const renamed = await renameTrack(db, args);
  if (!renamed) return null;
  await enqueueEmbedTrackMetadataBatch(db, [renamed.trackId]);
  return renamed;
}
