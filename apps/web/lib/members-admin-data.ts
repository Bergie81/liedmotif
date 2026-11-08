// Settings → Members data: every Member's aggregate footprint and
// spend, the outstanding invites, and the Pool panel — in one server-side
// load. Aggregates ONLY: the shape here is the whole payload the
// page ships to the client, so no content field may ever be added to it. The
// usage numbers come from the same counting functions enforcement uses.

import {
  getMembersPool,
  getUnitCosts,
  getUsageLimits,
  listMemberAccounts,
  listMemberLimits,
  listOpenMemberInvites,
  ownerScope,
  POOL_SCOPE,
} from '@liedmotif/db';
import {
  DEFAULT_MEMBER_LIMITS,
  poolOverSubscription,
  type MemberLimits,
  type MembersPool,
  type PoolOverSubscription,
  type UnitCosts,
} from '@liedmotif/shared';
import { readBudgetUsed, readBudgetUsedByOwner, readOneTimeBudgetUsed } from '@/lib/budget-usage';
import { getDb } from '@/lib/db';
import {
  budgetFigures,
  budgetUsage,
  type BudgetFigures,
  type BudgetUsage,
} from '@/lib/my-budget-model';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';

export interface MembersAdminMember {
  userId: string;
  name: string;
  joinedAt: string;
  lastActiveAt: string | null;
  disabled: boolean;
  /** Live tracks and stored bytes — what a delete would name. Informational. */
  trackCount: number;
  storageBytes: number;
  /** The stored budget (tasks) — what the edit form patches. */
  budget: MemberLimits;
  /** Usage against that budget, per its kind, already converted to Tracks/Covers. */
  usage: BudgetUsage;
}

export interface MembersAdminData {
  members: MembersAdminMember[];
  invites: Array<{
    id: string;
    label: string;
    email: string | null;
    createdAt: string;
    expiresAt: string;
  }>;
  pool: MembersPool;
  poolFigures: BudgetFigures;
  overSubscription: PoolOverSubscription[];
  defaultBudget: MemberLimits;
  tracksPerCall: number;
  /** The Admin's price per Track / Cover — Admin-only, like this whole payload. */
  unitCosts: UnitCosts;
}

export async function loadMembersAdminData(): Promise<MembersAdminData> {
  const db = getDb();
  const now = new Date();
  const tracksPerCall = getTypicalTracksPerMusicRequest();
  const instanceLimits = await getUsageLimits(db);
  const { resetTimezone } = instanceLimits;

  const [accounts, memberBudgets, pool, invites, unitCosts] = await Promise.all([
    listMemberAccounts(db),
    listMemberLimits(db),
    getMembersPool(db),
    listOpenMemberInvites(db),
    getUnitCosts(db),
  ]);
  const budgetsByUser = new Map(memberBudgets.map((entry) => [entry.userId, entry.limits]));

  // Rolling usage comes from one batched per-owner pass (the same counting
  // predicates the Member's own budget page uses, grouped by owner) rather than
  // a query set per member; the Pool aggregate is its own independent read. A
  // One-time budget is counted from its own Grant, so each is its own read.
  const [usedByOwner, poolUsed] = await Promise.all([
    readBudgetUsedByOwner(db, { resetTimezone, now }),
    readBudgetUsed(db, { scope: POOL_SCOPE, caps: pool, resetTimezone, now }),
  ]);
  const usageOf = async (userId: string, budget: MemberLimits): Promise<BudgetUsage> => {
    if (budget.kind !== 'oneTime') {
      return budgetUsage(
        { kind: 'rolling', caps: budget, used: usedByOwner(userId) },
        tracksPerCall,
      );
    }
    const used = await readOneTimeBudgetUsed(db, {
      scope: ownerScope(userId),
      grantedAt: new Date(budget.grantedAt ?? 0),
    });
    return budgetUsage({ kind: 'oneTime', totals: budget, used }, tracksPerCall);
  };
  const members = await Promise.all(
    accounts.map(async (account): Promise<MembersAdminMember> => {
      const budget = budgetsByUser.get(account.userId) ?? DEFAULT_MEMBER_LIMITS;
      return {
        userId: account.userId,
        name: account.name,
        joinedAt: account.joinedAt.toISOString(),
        lastActiveAt: account.lastActiveAt?.toISOString() ?? null,
        disabled: account.disabledAt !== null,
        trackCount: account.trackCount,
        storageBytes: account.storageBytes,
        budget,
        usage: await usageOf(account.userId, budget),
      };
    }),
  );

  return {
    members,
    invites: invites.map((invite) => ({
      id: invite.id,
      label: invite.label,
      email: invite.email,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
    })),
    pool,
    poolFigures: budgetFigures(pool, poolUsed, tracksPerCall),
    overSubscription: poolOverSubscription(
      memberBudgets.map((entry) => entry.limits),
      pool,
    ),
    defaultBudget: DEFAULT_MEMBER_LIMITS,
    tracksPerCall,
    unitCosts,
  };
}
