// Provider activity for diagnostics, from the domain tables (Graphile deletes
// completed jobs, so poll recency and retry history can only come from
// `provider_jobs`). Instance-wide on purpose: the diagnostics surface is
// admin-only and reports the whole deployment, not one owner. `provider_jobs`
// grows one row per paid provider call — a max/sum scan needs no index; do not
// add one for this.

import { and, desc, gte, isNotNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../transactions';
import { providerJobs } from '../schema';

export interface LastProviderPoll {
  /** The provider's own status string (e.g. `FIRST_SUCCESS`), falling back to
   * our normalized status before the first raw status lands. */
  providerStatus: string;
  at: Date;
}

/** The most recent update on any job that reached the provider, or `null`. */
export async function getLastProviderPoll(db: DbOrTx): Promise<LastProviderPoll | null> {
  const rows = await db
    .select({
      providerStatus: providerJobs.providerStatus,
      normalizedStatus: providerJobs.normalizedStatus,
      at: providerJobs.updatedAt,
    })
    .from(providerJobs)
    .where(isNotNull(providerJobs.providerTaskId))
    .orderBy(desc(providerJobs.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { providerStatus: row.providerStatus ?? row.normalizedStatus, at: row.at };
}

/**
 * Total poll retries on jobs touched since `windowStart` (the caller derives it
 * from the limits `resetTimezone` via `limitWindowStarts`). An approximation by
 * design: `retry_count` lives on the job row, so a job straddling midnight
 * counts its whole tally into today — fine for a diagnostics readout.
 */
export async function getProviderRetriesToday(db: DbOrTx, windowStart: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${providerJobs.retryCount}), 0)::int` })
    .from(providerJobs)
    .where(and(gte(providerJobs.updatedAt, windowStart), isNotNull(providerJobs.providerTaskId)));
  return rows[0]?.total ?? 0;
}
