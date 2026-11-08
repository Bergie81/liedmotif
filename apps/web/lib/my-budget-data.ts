// Settings → My budget data loader. Which budgets bind
// the viewer is `resolveBudgetScopes`' answer — the same resolution the submit
// and cover chokepoints use — and each one is counted by `readBudgetUsed`, so
// this readout can never disagree with a refusal.

import {
  getAdminDisplayName,
  getUsageLimits,
  resolveBudgetScopes,
  type BudgetScope,
  type Database,
} from '@liedmotif/db';
import { readBudgetUsed, readOneTimeBudgetUsed } from '@/lib/budget-usage';
import { getDb } from '@/lib/db';
import { buildMyBudgetData, type BudgetUsageInput, type MyBudgetData } from '@/lib/my-budget-model';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';

export interface MyBudgetPageData extends MyBudgetData {
  /** The one plain "who pays" line: the Admin's display name. */
  payerName: string | null;
}

/**
 * The page payload, or `null` when the viewer is not a Member — the page is a
 * Member's two bounds (their own and the Pool) and there is nothing to render
 * for anyone who has only one. The role question is answered here, by the same
 * resolution enforcement uses, so the page does not ask it a second way.
 */
export async function loadMyBudgetData(ownerUserId: string): Promise<MyBudgetPageData | null> {
  const db = getDb();
  const now = new Date();
  const instanceLimits = await getUsageLimits(db);
  const { resetTimezone } = instanceLimits;

  const [budget, payerName] = await Promise.all([
    resolveBudgetScopes(db, { ownerUserId, instanceLimits }),
    getAdminDisplayName(db),
  ]);
  // A Member resolves to [own budget, Pool] — the personal bound first, the
  // shared one second.
  const [yours, shared] = budget.scopes;
  if (!shared) return null;
  // The Pool is a rolling budget by construction (`resolveBudgetScopes`).
  if (shared.budget.kind !== 'rolling') throw new Error('The Members Pool is always rolling');
  const poolCaps = shared.budget.caps;

  const [yoursUsed, sharedUsed] = await Promise.all([
    readScopeUsage(db, yours, { resetTimezone, now }),
    readBudgetUsed(db, { scope: shared.spend, caps: poolCaps, resetTimezone, now }),
  ]);

  return {
    ...buildMyBudgetData({
      tracksPerCall: getTypicalTracksPerMusicRequest(),
      resetTimezone,
      yours: yoursUsed,
      shared: { caps: poolCaps, used: sharedUsed },
    }),
    payerName,
  };
}

/** Count one scope's spend the way its kind is bounded, paired with its own caps. */
async function readScopeUsage(
  db: Database,
  scope: BudgetScope,
  args: { resetTimezone: string; now: Date },
): Promise<BudgetUsageInput> {
  const { budget } = scope;
  if (budget.kind === 'oneTime') {
    const used = await readOneTimeBudgetUsed(db, {
      scope: scope.spend,
      grantedAt: budget.grantedAt,
    });
    return { kind: 'oneTime', totals: budget, used };
  }
  const used = await readBudgetUsed(db, { scope: scope.spend, caps: budget.caps, ...args });
  return { kind: 'rolling', caps: budget.caps, used };
}
