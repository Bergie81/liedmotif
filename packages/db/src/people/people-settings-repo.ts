import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { acquireOwnerCoverArtLock } from '../covers/generated-repo';
import { listenerProfiles } from '../schema';
import { withTransaction, type DbOrTx } from '../transactions';

export const COVER_REFERENCE_FREQUENCIES = ['always', 'regularly', 'seldom', 'never'] as const;
export type CoverReferenceFrequency = (typeof COVER_REFERENCE_FREQUENCIES)[number];

export async function getCoverReferenceFrequency(
  db: DbOrTx,
  ownerUserId: string,
): Promise<CoverReferenceFrequency> {
  const [profile] = await db
    .select({ frequency: listenerProfiles.coverReferenceFrequency })
    .from(listenerProfiles)
    .where(eq(listenerProfiles.ownerUserId, ownerUserId))
    .limit(1);
  return profile?.frequency ?? 'regularly';
}

export async function updateCoverReferenceFrequency(
  db: Database,
  ownerUserId: string,
  frequency: CoverReferenceFrequency,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    if (frequency === 'never') await acquireOwnerCoverArtLock(tx, ownerUserId);
    await tx
      .insert(listenerProfiles)
      .values({ ownerUserId, coverReferenceFrequency: frequency })
      .onConflictDoUpdate({
        target: listenerProfiles.ownerUserId,
        set: { coverReferenceFrequency: frequency, updatedAt: new Date() },
      });
  });
}
