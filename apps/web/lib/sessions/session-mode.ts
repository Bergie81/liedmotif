// Writing a Session's mode (server-only): the one path the New music control
// and the Assistant share, so a switch takes effect the same way from both.

import { setSessionMode, type Database, type SessionRecord } from '@liedmotif/db';
import { enqueueEnsureSessionBuffer } from '../worker-jobs';

/**
 * Sets the owner's Session to `mode`; null when the Session is absent or not
 * theirs. The worker consumes the mode on its next buffer tick, which is also
 * where a `repeat` Session's pending Dislike-reroll intents are cancelled, so
 * an active Session's tick is kicked here instead of waiting for the sweep
 * (never throws; deduped against the sweep by job key). A stopped Session
 * keeps the stored mode for its next Resume: nothing to tick.
 */
export async function switchSessionMode(
  db: Database,
  args: { ownerUserId: string; sessionId: string; mode: 'keep_going' | 'repeat' },
): Promise<SessionRecord | null> {
  const session = await setSessionMode(db, args);
  if (session?.status === 'active') await enqueueEnsureSessionBuffer(db, session.id);
  return session;
}
