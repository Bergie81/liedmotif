// Cost-control queries and the per-owner submit lock. Spend is counted in
// provider calls (tasks) — the atomic unit — by counting
// `provider_jobs` that have reached a submit state within the limit window. The
// window bound (`since`) comes from the shared `limitWindowStarts`, so there is
// ONE reset path. Session Repeat replays create no provider_jobs, so they are
// inherently not counted here.

import { and, count, eq, gt, gte, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import {
  LIVE_IN_FLIGHT_PROVIDER_STATUSES,
  PHANTOM_SUBMIT_PROVIDER_STATUSES,
} from '@liedmotif/shared';
import type { Database } from '../client';
import { spendScopeCondition, type SpendScope } from '../member-pool';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { generationRequests, providerJobs, SPEND_SUBMIT_STATES } from '../schema';
import { MEMBERS_POOL_LOCK_CLASS, OWNER_GENERATION_LOCK_CLASS } from '../advisory-locks';

/**
 * Submit states that hold a paid-generation slot. `submit_unknown` is included:
 * the call may have charged, so its slot is held — never auto-resubmitted.
 * `submit_rejected` is not: the provider refused unbilled and holds no task, so
 * nothing is incoming and nothing is running. A retry of the tick that parked it
 * is stopped by the refusal's own block signal (`mapProviderBlockSignal`), which
 * lifts the moment the provider config changes or the listener resumes.
 */
const IN_FLIGHT_SUBMIT_STATES = ['submitting', 'submitted', 'submit_unknown'] as const;

/**
 * The ONE definition of "this provider job occupies an in-flight (concurrency /
 * buffer) slot", shared by the per-session count (`countInFlightSessionJobs`) and
 * the owner-wide concurrency denominator (`countInFlightTasks`) so the two can
 * never drift:
 *
 * - LIVE statuses (shared bucket) count at any age — the poll loop owns advancing
 *   or terminalizing them.
 * - PHANTOM submit states (shared bucket: nothing advances them — `queued` covers
 *   the whole paid HTTP submit window, `submit_unknown` an uncertain parked
 *   submit; a `submit_rejected` row is already left out by its submit state)
 *   hold a slot only while STRICTLY younger than `phantomSubmitCutoff`,
 *   long enough to cover Graphile's retries of the submit that parked them, and
 *   dropped after — or one transient submit error would hold a concurrency slot
 *   (and satisfy the buffer watermark) forever. The strict `>` mirrors the
 *   worker's `ageMs < PHANTOM_SUBMIT_MAX_AGE_MS` stall window exactly.
 *
 * A phantom's SPEND is a separate question, answered by its submit state alone
 * and for the whole window (`countTasksInWindow`) — never by this age bound.
 */
export function inFlightProviderJobCondition(phantomSubmitCutoff: Date): SQL | undefined {
  return and(
    inArray(providerJobs.submitState, [...IN_FLIGHT_SUBMIT_STATES]),
    or(
      inArray(providerJobs.normalizedStatus, [...LIVE_IN_FLIGHT_PROVIDER_STATUSES]),
      and(
        inArray(providerJobs.normalizedStatus, [...PHANTOM_SUBMIT_PROVIDER_STATUSES]),
        gt(providerJobs.updatedAt, phantomSubmitCutoff),
      ),
    ),
  );
}

/** Rows that count as (possible) spend: reached a submit state, inside the window. */
function spendInWindowCondition(since: Date): SQL | undefined {
  return and(
    inArray(providerJobs.submitState, [...SPEND_SUBMIT_STATES]),
    gte(providerJobs.createdAt, since),
  );
}

/**
 * Count spent tasks (submitted provider jobs) in one spend scope, created at or
 * after `since` — a limit-window start (`limitWindowStarts`). Money-conservative:
 * `submit_unknown` counts as spend.
 */
export async function countTasksInWindow(
  db: DbOrTx,
  args: { scope: SpendScope; since: Date },
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        spendScopeCondition(args.scope, generationRequests.ownerUserId),
        spendInWindowCondition(args.since),
      ),
    );
  return row?.value ?? 0;
}

/**
 * `countTasksInWindow` for EVERY owner at once (`GROUP BY owner_user_id`). The
 * null owner is the deleted accounts' surviving ledger (set-null FK), kept as
 * one group so the rows still sum to the instance's whole spend.
 */
export async function countTasksInWindowByOwnerOrDeleted(
  db: DbOrTx,
  args: { since: Date },
): Promise<Array<{ ownerUserId: string | null; value: number }>> {
  return db
    .select({ ownerUserId: generationRequests.ownerUserId, value: count() })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(spendInWindowCondition(args.since))
    .groupBy(generationRequests.ownerUserId);
}

/**
 * The batched read behind admin surfaces that show all Members. Owners with no
 * counted job are simply absent (read a missing key as 0). Requests whose owner
 * was deleted (null after set-null) are excluded: they have no row to display.
 */
export async function countTasksInWindowByOwner(
  db: DbOrTx,
  args: { since: Date },
): Promise<Map<string, number>> {
  const rows = await db
    .select({ ownerUserId: generationRequests.ownerUserId, value: count() })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(and(isNotNull(generationRequests.ownerUserId), spendInWindowCondition(args.since)))
    .groupBy(generationRequests.ownerUserId);
  return new Map(rows.map((row) => [row.ownerUserId!, row.value]));
}

/** One scope to count, with the `since` instant of each of its spend windows. */
export interface ScopeSpendWindows {
  spend: SpendScope;
  since: readonly Date[];
}

export interface ScopeSpendAndInFlight {
  /** Spent tasks per window, aligned with the scope's `since` list. */
  tasksUsed: number[];
  inFlightTasks: number;
}

/**
 * The cost-control counts (`countTasksInWindow` per window + `countInFlightTasks`)
 * for every scope in ONE statement. The buffer tick runs these inside the owner
 * advisory lock — and a Member's tick inside the Pool lock too — so every round
 * trip saved is directly less lock hold. Each count is a `FILTER` aggregate
 * over one scan whose base predicate admits exactly the rows some aggregate
 * could match; the per-count predicates are the same ones the standalone
 * functions use. Results align with `args.scopes` by index, and each scope's
 * `tasksUsed` with its `since` list.
 */
export async function countSpendAndInFlightForScopes(
  db: DbOrTx,
  args: {
    scopes: readonly ScopeSpendWindows[];
    phantomSubmitCutoff: Date;
  },
): Promise<ScopeSpendAndInFlight[]> {
  if (args.scopes.length === 0) return [];
  const inFlight = inFlightProviderJobCondition(args.phantomSubmitCutoff);
  const countWhere = (condition: SQL | undefined): SQL<number> =>
    sql<number>`(count(*) filter (where ${condition}))::int`;
  // The one place the per-scope column names exist — selection build and row
  // read-back share it, so the two sides cannot drift.
  const columns = (scope: number, window: number) => `used${scope}_${window}`;
  const inFlightColumn = (scope: number) => `inFlight${scope}`;
  const selection: Record<string, SQL<number>> = {};
  const scopeConditions = args.scopes.map((scope) =>
    spendScopeCondition(scope.spend, generationRequests.ownerUserId),
  );
  scopeConditions.forEach((scopeCondition, index) => {
    args.scopes[index]!.since.forEach((since, window) => {
      selection[columns(index, window)] = countWhere(
        and(scopeCondition, spendInWindowCondition(since)),
      );
    });
    selection[inFlightColumn(index)] = countWhere(and(scopeCondition, inFlight));
  });
  // Every window's rows are a subset of the earliest window's.
  const earliest = new Date(
    Math.min(...args.scopes.flatMap((scope) => scope.since.map((since) => since.getTime()))),
  );
  const [row] = await db
    .select(selection)
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(and(or(...scopeConditions), or(spendInWindowCondition(earliest), inFlight)));
  return args.scopes.map((scope, index) => ({
    tasksUsed: scope.since.map((_, window) => row?.[columns(index, window)] ?? 0),
    inFlightTasks: row?.[inFlightColumn(index)] ?? 0,
  }));
}

/**
 * Count in-flight provider jobs in one spend scope — the `maxConcurrentJobs`
 * denominator. A job holds its concurrency slot for the entire paid HTTP submit
 * window (`queued`/`submitting`) and while parked as an uncertain submit, not
 * just once the provider confirmed it.
 */
export async function countInFlightTasks(
  db: DbOrTx,
  args: { scope: SpendScope; phantomSubmitCutoff: Date },
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(providerJobs)
    .innerJoin(generationRequests, eq(providerJobs.generationRequestId, generationRequests.id))
    .where(
      and(
        spendScopeCondition(args.scope, generationRequests.ownerUserId),
        inFlightProviderJobCondition(args.phantomSubmitCutoff),
      ),
    );
  return row?.value ?? 0;
}

/**
 * Run `fn` inside a transaction holding a BLOCKING per-owner advisory lock — the
 * cost-control chokepoint. Limit/concurrency counts, the decision they feed, and
 * the `submitting` row insert must be one mutually-exclusive sequence per owner:
 * without it, two sessions' buffer ticks (per-session `job_key` only serializes
 * WITHIN a session) both read `dailyUsed = cap − 1` (or `inFlight = 0` with
 * `maxConcurrentJobs = 1`), both pass, and both submit — cost controls are
 * non-bypassable, so check-then-insert must not race. The lock is
 * transaction-scoped (auto-released on commit/rollback), and the paid provider
 * call itself must NEVER run under it — once the `submitting` row commits it is
 * already counted by the spend/in-flight queries above.
 *
 * The session lifecycle writers (`session-command-repo`) take this same lock:
 * making a session active is the act that opens an owner's generation stream,
 * and serializing it here is what keeps the one-active-per-owner index from
 * being raced by two simultaneous starts.
 */
export async function withOwnerGenerationLock<T>(
  db: Database,
  ownerUserId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${OWNER_GENERATION_LOCK_CLASS}, hashtext(${ownerUserId}))`,
    );
    return fn(tx);
  });
}

/**
 * Acquire the Members-Pool-wide advisory lock. The per-owner lock
 * serializes an owner against themselves, but two DIFFERENT Members hold
 * different owner locks and would both read "Pool = cap − 1" and both submit —
 * so a Member's admission additionally serializes on this single Pool lock.
 *
 * LOCK ORDER IS FIXED: owner lock first, THEN this — never the reverse, or two
 * Member submits deadlock. The `Transaction` parameter enforces half of that
 * by construction (there is no path to a tx here except through
 * `withOwnerGenerationLock` / the cover admission lock); the other half is
 * this rule: no caller may take this lock before its owner-scoped lock. Nor
 * may it lock an `activity_sessions` row after it: the buffer tick holds its
 * Session row while it waits here, so a path that takes this lock and then
 * writes a Session row deadlocks against a tick of that Session — lock the row
 * first. Admin submits are not Pool-bound and never take it. Transaction-scoped,
 * auto-released on commit/rollback.
 */
export async function acquireMembersPoolLock(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${MEMBERS_POOL_LOCK_CLASS}, 0)`);
}
