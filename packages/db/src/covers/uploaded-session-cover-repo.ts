// Registration of an OWNER-UPLOADED Session cover. An upload is not a
// generation: it buys nothing, so it never touches the generation ledger and
// never counts against a spend window. What it does share with a generated
// cover is the session's history — it is re-selectable, deletable, and occupies
// one of the session's history slots — so the cap is enforced here, under the
// same per-owner lock the generation admission takes.

import type { Database } from '../client';
import { coverImages } from '../schema';
import { countSessionCoverHistory, withOwnerCoverAdmissionLock } from './generation-ledger-repo';

export interface AddUploadedSessionCoverInput {
  /** The freshly stored upload's identity + location (bytes already written). */
  coverImageId: string;
  ownerUserId: string;
  activitySessionId: string;
  storageProvider: string;
  storageKey: string;
  /** Size of the written object — what the storage quota counts this cover as. */
  byteSize: number;
  /** History slots the session may occupy, uploads and generated covers alike. */
  maxHistory: number;
}

export type AddUploadedSessionCoverResult = 'added' | 'history_full';

/**
 * Register an uploaded cover in a session's history WITHOUT applying it — the
 * owner previews it and saves the swap explicitly, exactly like a rerolled
 * cover. Returns `history_full` when the cap is already taken, in which case
 * the caller compensates by deleting the just-written bytes.
 */
export async function addUploadedSessionCover(
  db: Database,
  input: AddUploadedSessionCoverInput,
): Promise<AddUploadedSessionCoverResult> {
  return withOwnerCoverAdmissionLock(db, input.ownerUserId, async (tx) => {
    const kept = await countSessionCoverHistory(tx, {
      ownerUserId: input.ownerUserId,
      activitySessionId: input.activitySessionId,
    });
    if (kept >= input.maxHistory) return 'history_full';
    await tx.insert(coverImages).values({
      id: input.coverImageId,
      sourceType: 'uploaded',
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
      byteSize: input.byteSize,
      tags: { label: 'Uploaded cover' },
      // The owner in provenance is what gates the serving route: a personal
      // image is served to its owner only, never as instance-global art.
      provenance: {
        ownerUserId: input.ownerUserId,
        activitySessionId: input.activitySessionId,
      },
    });
    return 'added';
  });
}
