// Writes for GENERATED Session Cover art (worker `generate-session-cover` job).
// `cover_images` is instance-global, so a generated cover carries its owner and
// session in safe public provenance. The private generation ledger owns
// idempotency and cost accounting. Provenance stores only safe metadata (model,
// ids, cost, reference ids) — never base64 image data, prompts with person
// descriptions, provider URLs, or secrets.

import { and, eq, gte, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import {
  activitySessions,
  APP_SETTINGS_KEYS,
  coverImages,
  sessionCoverGenerations,
  type CoverMetadata,
} from '../schema';
import { readSetting } from '../setup/settings';
import { spendScopeCondition, type SpendScope } from '../member-pool';
import { OWNER_COVER_ART_LOCK_CLASS } from '../advisory-locks';
import { PLACEHOLDER_COVER_ID } from './placeholder';

/**
 * Take the per-owner reference-privacy lock on an open transaction. The
 * submission claim + reference re-read and privacy-sensitive profile writes
 * take it — deleting a reference image and switching the frequency to `never`
 * — so a job locking after a hard opt-out always reads the post-opt-out state.
 */
export async function acquireOwnerCoverArtLock(
  tx: Transaction,
  ownerUserId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${OWNER_COVER_ART_LOCK_CLASS}, hashtext(${ownerUserId}))`,
  );
}

/**
 * Hold reference privacy across the final policy/row/byte re-read. The paid
 * provider call itself runs OUTSIDE this lock (the music path's rule) — the
 * lock guards which references a submission reads, never the submission's
 * network wait. Admission and planning use a separate short lock.
 */
export async function withOwnerCoverArtLock<T>(
  db: Database,
  ownerUserId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    await acquireOwnerCoverArtLock(tx, ownerUserId);
    return fn(tx);
  });
}

export interface InsertGeneratedCoverInput {
  /** Pre-generated id, so the storage key and row id agree. */
  id: string;
  ownerUserId: string;
  activitySessionId: string;
  storageProvider: string;
  storageKey: string;
  /** Size of the written object — what the storage quota counts this cover as. */
  byteSize: number;
  /** Short alt/label text (cosmetic; shown as the cover title). */
  label: string;
  model: string;
  activityFit: string[];
  moodFit: string[];
  genreFit: string[];
  energyFit: string[];
  visualTheme?: string | null;
  /** Extra safe provenance (promptVersion, referenceIds, costUsd, …). */
  provenance?: CoverMetadata;
}

/** Insert a generated `cover_images` row; returns its id. */
export async function insertGeneratedCoverImage(
  db: DbOrTx,
  input: InsertGeneratedCoverInput,
): Promise<string> {
  const [row] = await db
    .insert(coverImages)
    .values({
      id: input.id,
      sourceType: 'generated',
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
      byteSize: input.byteSize,
      tags: { label: input.label, model: input.model },
      activityFit: input.activityFit,
      moodFit: input.moodFit,
      genreFit: input.genreFit,
      energyFit: input.energyFit,
      visualTheme: input.visualTheme ?? null,
      provenance: {
        ownerUserId: input.ownerUserId,
        activitySessionId: input.activitySessionId,
        model: input.model,
        ...input.provenance,
      },
    })
    .onConflictDoNothing({ target: coverImages.id })
    .returning({ id: coverImages.id });
  if (row) return row.id;
  const [existing] = await db
    .select()
    .from(coverImages)
    .where(eq(coverImages.id, input.id))
    .limit(1);
  const provenance = existing?.provenance as Record<string, unknown> | null;
  if (
    existing?.sourceType === 'generated' &&
    existing.storageKey === input.storageKey &&
    provenance?.ownerUserId === input.ownerUserId &&
    provenance?.activitySessionId === input.activitySessionId
  ) {
    return existing.id;
  }
  throw new Error('Generated cover identity conflict.');
}

/**
 * Point a session at a cover, owner-scoped. Applies whether the session is
 * active or already stopped — a cover that finishes after the user stopped the
 * session still improves My Sessions / Resume. Returns false when the session
 * is absent or not owned.
 */
export async function setSessionCoverImage(
  db: DbOrTx,
  args: { ownerUserId: string; sessionId: string; coverImageId: string },
): Promise<boolean> {
  const updated = await db
    .update(activitySessions)
    .set({ coverImageId: args.coverImageId })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .returning({ id: activitySessions.id });
  return updated.length > 0;
}

/**
 * Swap a session's INITIAL cover (the built-in placeholder, or none) for a real
 * one, owner-scoped. Conditional on the current cover so it can never clobber a
 * generated cover that landed concurrently — the generated cover always wins.
 * Returns false when the session is absent, not owned, or already wears a real
 * cover.
 */
export async function replaceInitialSessionCover(
  db: DbOrTx,
  args: { ownerUserId: string; sessionId: string; coverImageId: string },
): Promise<boolean> {
  const updated = await db
    .update(activitySessions)
    .set({ coverImageId: args.coverImageId })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
        or(
          eq(activitySessions.coverImageId, PLACEHOLDER_COVER_ID),
          isNull(activitySessions.coverImageId),
        ),
      ),
    )
    .returning({ id: activitySessions.id });
  return updated.length > 0;
}

/**
 * Persist an explicit user cover-style pick on the session (the regenerate
 * modal's Advanced fold). Satisfies the authoritative-style CHECK: a Custom
 * pick carries its definition as the hint, any other pick clears both hint
 * columns; the fallback reason resets — the pick is deliberate. Returns false
 * when the Session is absent or not owned.
 */
export async function setSessionCoverStyle(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    sessionId: string;
    coverStyle: (typeof activitySessions.$inferInsert)['coverStyle'];
    coverStyleHint?: string | null;
  },
): Promise<boolean> {
  const updated = await db
    .update(activitySessions)
    .set({
      coverStyle: args.coverStyle,
      coverStyleHint: args.coverStyle === 'custom' ? (args.coverStyleHint ?? null) : null,
      coverStyleHintNormalized: null,
      coverStyleFallbackReason: null,
    })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .returning({ id: activitySessions.id });
  return updated.length > 0;
}

/**
 * Normalize an authoritative Custom row whose normalized definition is absent.
 * Returns false when the Session is absent or not owned.
 */
export async function setSessionCoverStyleHintNormalized(
  db: DbOrTx,
  args: { ownerUserId: string; sessionId: string; normalized: string },
): Promise<boolean> {
  const updated = await db
    .update(activitySessions)
    .set({ coverStyleHintNormalized: args.normalized })
    .where(
      and(
        eq(activitySessions.id, args.sessionId),
        eq(activitySessions.ownerUserId, args.ownerUserId),
      ),
    )
    .returning({ id: activitySessions.id });
  return updated.length > 0;
}

/**
 * The generated cover already bought for this session, or `null` (the job's
 * idempotency check — a retried/duplicated job must never buy a second cover).
 * Checks `cover_images` by provenance rather than the session's current
 * `coverImageId`, so a crash between insert and session update still
 * short-circuits — and the returned row lets the retry finish landing that
 * cover (or fall back) instead of stranding the session's initial cover.
 */
export async function getGeneratedCoverForSession(
  db: DbOrTx,
  activitySessionId: string,
): Promise<typeof coverImages.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(coverImages)
    .where(
      and(
        eq(coverImages.sourceType, 'generated'),
        sql`${coverImages.provenance} ->> 'activitySessionId' = ${activitySessionId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Successfully generated covers for an owner since `since` — the cover
 * cost-limit window count (a cover counts only once its row exists, i.e. the
 * provider call succeeded).
 */
export async function countGeneratedCoversInWindow(
  db: DbOrTx,
  args: { ownerUserId: string; since: Date },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(coverImages)
    .where(
      and(
        eq(coverImages.sourceType, 'generated'),
        sql`${coverImages.provenance} ->> 'ownerUserId' = ${args.ownerUserId}`,
        gte(coverImages.createdAt, args.since),
      ),
    );
  return row?.count ?? 0;
}

/** The provenance owner expression every legacy-cover predicate keys on. */
const legacyOwner = () => sql<string>`${coverImages.provenance} ->> 'ownerUserId'`;

/**
 * A generated cover counts as pre-ledger LEGACY spend when it is attributed to
 * an owner but no ledger row claims it (the anti-join). An unattributed
 * generated cover is nobody's spend and is budgeted against nobody. The claim
 * is by cover id alone: a deleted Member's ledger row keeps claiming its cover
 * with a null owner, or the same spend would count twice.
 */
function legacyGeneratedCoverCondition() {
  return and(
    eq(coverImages.sourceType, 'generated'),
    isNotNull(legacyOwner()),
    sql`not exists (
      select 1 from ${sessionCoverGenerations}
      where ${sessionCoverGenerations.coverImageId} = ${coverImages.id}
    )`,
  );
}

/**
 * The pre-ledger legacy cover count in one spend scope. Short-circuited by the
 * persisted exhaustion flag, computed ONCE by migration 0064: the legacy set
 * only ever shrinks (new generated covers are always ledger-claimed), so an
 * instance whose set was empty at migration time — every fresh instance —
 * answers with one key read forever. A `false` verdict is permanent: an
 * instance with a legacy history simply keeps the (indexed) windowed count,
 * which is cheaper than re-probing to catch an eventual manual cleanup.
 */
export async function countLegacyGeneratedCoversInWindow(
  db: DbOrTx,
  args: { scope: SpendScope; since: Date },
): Promise<number> {
  const exhausted = await readSetting<boolean>(
    db,
    APP_SETTINGS_KEYS.legacyGeneratedCoversExhausted,
  );
  if (exhausted === true) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(coverImages)
    .where(
      and(
        legacyGeneratedCoverCondition(),
        spendScopeCondition(args.scope, legacyOwner()),
        gte(coverImages.createdAt, args.since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * `countLegacyGeneratedCoversInWindow` for every owner at once, as a grouped
 * query for `countCoverSpendByOwner`'s one-statement union. Deliberately skips
 * the exhaustion flag: as one leg of a single indexed statement on a cold admin
 * page it costs nothing, and the flag read would be a second round trip.
 */
export function legacyGeneratedCoversByOwnerQuery(db: DbOrTx, since: Date) {
  return db
    .select({
      ownerUserId: legacyOwner(),
      value: sql<number>`count(*)::int`,
    })
    .from(coverImages)
    .where(and(legacyGeneratedCoverCondition(), gte(coverImages.createdAt, since)))
    .groupBy(legacyOwner());
}
