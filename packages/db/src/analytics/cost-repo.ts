// Admin cost comparison: who the instance's possibly-paid spend
// belongs to. Counted by the budget accounting's own grouped reads, so a figure
// here can never disagree with a budget meter; this module only sorts the owners
// into payer groups. It touches no content table.

import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { countCoverSpendByOwnerOrDeleted } from '../covers/usage';
import { countTasksInWindowByOwnerOrDeleted } from '../generation/limits-repo';
import { user, userProfiles } from '../schema';

/** Spend in the accounting's own units: music-model calls and generated Covers. */
export interface SpendCounts {
  tasks: number;
  covers: number;
}

export interface CostComparison {
  own: SpendCounts;
  /** Every current Member in join order, spenders or not. */
  perMember: Array<SpendCounts & { userId: string; name: string }>;
  /**
   * Spend of owners who are neither the Admin nor a current Member. A deleted
   * account's music calls and Cover attempts both outlive it, as the Pool counts.
   */
  formerMembers: SpendCounts;
}

export async function getCostComparison(
  db: Database,
  args: { adminUserId: string; since: Date },
): Promise<CostComparison> {
  const [members, taskRows, coversByOwner] = await Promise.all([
    db
      .select({ userId: userProfiles.userId, name: user.name })
      .from(userProfiles)
      .innerJoin(user, eq(user.id, userProfiles.userId))
      .where(eq(userProfiles.role, 'member'))
      .orderBy(userProfiles.createdAt),
    countTasksInWindowByOwnerOrDeleted(db, { since: args.since }),
    countCoverSpendByOwnerOrDeleted(db, { since: args.since }),
  ]);

  const own: SpendCounts = { tasks: 0, covers: 0 };
  const formerMembers: SpendCounts = { tasks: 0, covers: 0 };
  const perMember = members.map((member) => ({ ...member, tasks: 0, covers: 0 }));
  const byUserId = new Map<string | null, SpendCounts>(perMember.map((row) => [row.userId, row]));
  byUserId.set(args.adminUserId, own);
  // Anyone unknown lands in Former members, so the groups always sum to the whole.
  const groupOf = (ownerUserId: string | null) => byUserId.get(ownerUserId) ?? formerMembers;

  for (const row of taskRows) groupOf(row.ownerUserId).tasks += row.value;
  for (const [ownerUserId, covers] of coversByOwner) groupOf(ownerUserId).covers += covers;

  return { own, perMember, formerMembers };
}
