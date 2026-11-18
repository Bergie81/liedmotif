import { and, asc, desc, eq, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  activitySessions,
  coverImages,
  emptySessionCoverPlan,
  SESSION_COVER_LIVE_STATES,
  sessionCoverGenerations,
  type SessionCoverPlanRecord,
  type SessionCoverSelectedReference,
} from '../schema';
import { withTransaction, type DbOrTx, type Transaction } from '../transactions';
import { queueCoverFileDeletions } from './cover-reclaim';
import { spendScopeCondition, type SpendScope } from '../member-pool';
import { OWNER_COVER_ADMISSION_LOCK_CLASS } from '../advisory-locks';

export type SessionCoverGenerationRow = typeof sessionCoverGenerations.$inferSelect;

/**
 * Subject parameterization: Session and Playlist covers share this ledger and
 * differ only in which id owns them. The kind is the ONE discriminator — the
 * ledger column and the provenance key an uploaded cover carries are both
 * derived from it, so they cannot drift apart. Not part of the package's public
 * API — the subject-specific repos wrap it.
 */
export interface CoverLedgerSubject {
  kind: 'session' | 'playlist';
  id: string;
}

export function sessionLedgerSubject(activitySessionId: string): CoverLedgerSubject {
  return { kind: 'session', id: activitySessionId };
}

export function playlistLedgerSubject(playlistId: string): CoverLedgerSubject {
  return { kind: 'playlist', id: playlistId };
}

export function subjectWhere(subject: CoverLedgerSubject) {
  return subject.kind === 'playlist'
    ? eq(sessionCoverGenerations.playlistId, subject.id)
    : eq(sessionCoverGenerations.activitySessionId, subject.id);
}

function subjectValues(
  subject: CoverLedgerSubject,
): { activitySessionId: string } | { playlistId: string } {
  return subject.kind === 'playlist'
    ? { playlistId: subject.id }
    : { activitySessionId: subject.id };
}

/** The `cover_images.provenance` key an UPLOADED cover carries to name a subject. */
function subjectProvenanceKey(subject: CoverLedgerSubject): 'activitySessionId' | 'playlistId' {
  return subject.kind === 'playlist' ? 'playlistId' : 'activitySessionId';
}

export async function acquireOwnerCoverAdmissionLock(
  tx: Transaction,
  ownerUserId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${OWNER_COVER_ADMISSION_LOCK_CLASS}, hashtext(${ownerUserId}))`,
  );
}

export async function withOwnerCoverAdmissionLock<T>(
  db: Database,
  ownerUserId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    await acquireOwnerCoverAdmissionLock(tx, ownerUserId);
    return fn(tx);
  });
}

/**
 * The session's authoritative attempt: the single live one when work is in
 * flight, else the newest settled one (the attempt whose outcome the session
 * currently reflects).
 */
export async function getSessionCoverGeneration(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .select()
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
        eq(sessionCoverGenerations.activitySessionId, args.activitySessionId),
      ),
    )
    .orderBy(
      sql`case when ${sessionCoverGenerations.state} in ('reserved', 'planned', 'submitting', 'storing') then 0 else 1 end`,
      desc(sessionCoverGenerations.createdAt),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The session's newest automatic attempt (any trigger but `user_regenerate`),
 * if any. A user regeneration never stands in for it: until one exists, the
 * Session's initial cover is still owed.
 */
export async function getInitialSessionCoverGeneration(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .select()
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
        eq(sessionCoverGenerations.activitySessionId, args.activitySessionId),
        ne(sessionCoverGenerations.trigger, 'user_regenerate'),
      ),
    )
    .orderBy(desc(sessionCoverGenerations.createdAt))
    .limit(1);
  return row ?? null;
}

/** The subject's single live (non-terminal) attempt, if any. */
export async function getLiveCoverGenerationForSubject(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .select()
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, ownerUserId),
        subjectWhere(subject),
        inArray(sessionCoverGenerations.state, [...SESSION_COVER_LIVE_STATES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The session's single live (non-terminal) attempt, if any. */
export async function getLiveSessionCoverGeneration(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<SessionCoverGenerationRow | null> {
  return getLiveCoverGenerationForSubject(
    db,
    args.ownerUserId,
    sessionLedgerSubject(args.activitySessionId),
  );
}

/** The subject's newest user-regeneration attempt (live or settled), if any. */
export async function getLatestCoverRegenerationForSubject(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .select()
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, ownerUserId),
        subjectWhere(subject),
        eq(sessionCoverGenerations.trigger, 'user_regenerate'),
      ),
    )
    .orderBy(desc(sessionCoverGenerations.createdAt))
    .limit(1);
  return row ?? null;
}

/** The newest user-regeneration attempt (live or settled), if any. */
export async function getLatestSessionCoverRegeneration(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<SessionCoverGenerationRow | null> {
  return getLatestCoverRegenerationForSubject(
    db,
    args.ownerUserId,
    sessionLedgerSubject(args.activitySessionId),
  );
}

/**
 * The subject's settled generated covers (its selectable history), newest
 * first. Only attempts whose `cover_images` row still exists are listed —
 * every entry is servable and free to re-select.
 */
export async function listCoverHistoryForSubject(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
  limit?: number,
): Promise<SessionCoverGenerationRow[]> {
  const rows = await db
    .select({ generation: sessionCoverGenerations })
    .from(sessionCoverGenerations)
    .innerJoin(coverImages, eq(coverImages.id, sessionCoverGenerations.coverImageId))
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, ownerUserId),
        subjectWhere(subject),
        eq(sessionCoverGenerations.state, 'ready'),
      ),
    )
    .orderBy(desc(sessionCoverGenerations.createdAt))
    .limit(Math.max(1, Math.min(limit ?? 48, 48)));
  return rows.map((row) => row.generation);
}

/**
 * The session's settled generated covers (its selectable history), newest
 * first. The placeholder cover never appears here.
 */
export async function listSessionCoverHistory(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string; limit?: number },
): Promise<SessionCoverGenerationRow[]> {
  return listCoverHistoryForSubject(
    db,
    args.ownerUserId,
    sessionLedgerSubject(args.activitySessionId),
    args.limit,
  );
}

export interface UploadedCover {
  coverImageId: string;
  storageKey: string;
  createdAt: Date;
}

/**
 * Uploaded covers belonging to one subject, newest first. Uploads are
 * instance-global `cover_images` rows carrying their owner and subject only in
 * provenance, so membership is provenance-matched here rather than joined.
 */
export async function listUploadedCoversForSubject(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
): Promise<UploadedCover[]> {
  return db
    .select({
      coverImageId: coverImages.id,
      storageKey: coverImages.storageKey,
      createdAt: coverImages.createdAt,
    })
    .from(coverImages)
    .where(
      and(
        eq(coverImages.sourceType, 'uploaded'),
        sql`${coverImages.provenance} ->> 'ownerUserId' = ${ownerUserId}`,
        sql`${coverImages.provenance} ->> ${subjectProvenanceKey(subject)}::text = ${subject.id}`,
      ),
    )
    .orderBy(desc(coverImages.createdAt));
}

/** Uploaded covers belonging to one session, newest first. */
export async function listUploadedSessionCovers(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<UploadedCover[]> {
  return listUploadedCoversForSubject(
    db,
    args.ownerUserId,
    sessionLedgerSubject(args.activitySessionId),
  );
}

/**
 * How many of the session's cover slots are taken: settled generated attempts,
 * uploads, and the single in-flight attempt that is about to claim one. The
 * single authority for the per-session history cap — counting the live attempt
 * is what stops an upload alongside it from landing the session past the cap.
 */
export async function countSessionCoverHistory(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string },
): Promise<number> {
  const generated = await listSessionCoverHistory(db, args);
  const uploaded = await listUploadedSessionCovers(db, args);
  const live = await getLiveSessionCoverGeneration(db, args);
  return generated.length + uploaded.length + (live ? 1 : 0);
}

/** The history entry for one cover, or null when it is not in this subject's history. */
export async function getCoverHistoryEntryForSubject(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
  coverImageId: string,
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .select({ generation: sessionCoverGenerations })
    .from(sessionCoverGenerations)
    .innerJoin(coverImages, eq(coverImages.id, sessionCoverGenerations.coverImageId))
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, ownerUserId),
        subjectWhere(subject),
        eq(sessionCoverGenerations.state, 'ready'),
        eq(sessionCoverGenerations.coverImageId, coverImageId),
      ),
    )
    .limit(1);
  return row?.generation ?? null;
}

/**
 * One cover from the subject's history, whoever made it: a settled generated
 * attempt or an upload. The single membership question — select and delete both
 * ask it, and neither has to know the two halves apart.
 */
export async function findCoverInSubjectHistory(
  db: DbOrTx,
  ownerUserId: string,
  subject: CoverLedgerSubject,
  coverImageId: string,
): Promise<{ coverImageId: string; storageKey: string } | null> {
  const generated = await getCoverHistoryEntryForSubject(db, ownerUserId, subject, coverImageId);
  if (generated) return { coverImageId, storageKey: generated.storageKey };
  const uploads = await listUploadedCoversForSubject(db, ownerUserId, subject);
  return uploads.find((upload) => upload.coverImageId === coverImageId) ?? null;
}

/** One cover from a session's history, generated or uploaded; see the subject form. */
export async function findCoverInSessionHistory(
  db: DbOrTx,
  args: { ownerUserId: string; activitySessionId: string; coverImageId: string },
): Promise<{ coverImageId: string; storageKey: string } | null> {
  return findCoverInSubjectHistory(
    db,
    args.ownerUserId,
    sessionLedgerSubject(args.activitySessionId),
    args.coverImageId,
  );
}

export type DeleteSessionCoverHistoryResult = 'deleted' | 'not_found' | 'current_cover';

export interface CoverHistoryDeletionSpec {
  /** Resolve the deletable cover's storage key; null means 'not_found'. */
  storageKey(tx: Transaction): Promise<string | null>;
  /** The subject's CURRENT cover pointer — never deletable (it must stay servable). */
  currentCoverImageId(tx: Transaction): Promise<string | null | undefined>;
  deletionReason: string;
}

/**
 * Delete one cover from a subject's history: the `cover_images` row goes and
 * its bytes are queued for reclamation, while a generated attempt's ledger row
 * stays untouched — spend accounting and provenance survive, and the history
 * join simply stops listing the attempt.
 */
export async function deleteCoverFromHistoryForSubject(
  db: Database,
  args: { ownerUserId: string; coverImageId: string; now?: Date },
  spec: CoverHistoryDeletionSpec,
): Promise<DeleteSessionCoverHistoryResult> {
  const now = args.now ?? new Date();
  return withTransaction(db, async (tx) => {
    const storageKey = await spec.storageKey(tx);
    if (!storageKey) return 'not_found';
    if ((await spec.currentCoverImageId(tx)) === args.coverImageId) return 'current_cover';
    await tx.delete(coverImages).where(eq(coverImages.id, args.coverImageId));
    await queueCoverFileDeletions(tx, {
      ownerUserId: args.ownerUserId,
      covers: [{ coverImageId: args.coverImageId, storageKey }],
      reason: spec.deletionReason,
      now,
    });
    return 'deleted';
  });
}

/**
 * Delete one cover from a session's history — a settled generated attempt or an
 * uploaded cover. The session's CURRENT cover is never deletable (the pointer
 * must stay servable).
 */
export async function deleteSessionCoverFromHistory(
  db: Database,
  args: { ownerUserId: string; activitySessionId: string; coverImageId: string; now?: Date },
): Promise<DeleteSessionCoverHistoryResult> {
  return deleteCoverFromHistoryForSubject(db, args, {
    storageKey: async (tx) => (await findCoverInSessionHistory(tx, args))?.storageKey ?? null,
    currentCoverImageId: async (tx) => {
      const [session] = await tx
        .select({ coverImageId: activitySessions.coverImageId })
        .from(activitySessions)
        .where(
          and(
            eq(activitySessions.id, args.activitySessionId),
            eq(activitySessions.ownerUserId, args.ownerUserId),
          ),
        )
        .limit(1);
      return session?.coverImageId;
    },
    deletionReason: 'session_cover_history_deleted',
  });
}

/** A specific attempt by ledger id, owner-scoped. */
export async function getSessionCoverGenerationById(
  db: DbOrTx,
  args: { ownerUserId: string; id: string },
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .select()
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
        eq(sessionCoverGenerations.id, args.id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRecentSessionCoverGenerations(
  db: DbOrTx,
  args: { ownerUserId: string; limit?: number },
): Promise<SessionCoverGenerationRow[]> {
  return db
    .select()
    .from(sessionCoverGenerations)
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
        inArray(sessionCoverGenerations.state, ['ready', 'planned', 'submitting', 'storing']),
      ),
    )
    .orderBy(desc(sessionCoverGenerations.createdAt))
    .limit(Math.max(1, Math.min(args.limit ?? 24, 24)));
}

/**
 * The Instance's newest Cover outcome that says something about the image
 * provider's account: a Cover that landed, or an attempt the provider refused
 * because the account is not ready for images. Other failures are skipped, so
 * an outage after the refusal does not hide it. Across every owner, because the
 * account is the Instance's.
 */
export async function getLatestCoverAccountOutcome(
  db: DbOrTx,
): Promise<{ providerKey: string; accountNotReady: boolean; settledAt: Date } | null> {
  const [row] = await db
    .select({
      providerKey: sessionCoverGenerations.providerKey,
      failureCategory: sessionCoverGenerations.failureCategory,
      settledAt: sessionCoverGenerations.settledAt,
    })
    .from(sessionCoverGenerations)
    .where(
      and(
        sql`${sessionCoverGenerations.settledAt} is not null`,
        or(
          eq(sessionCoverGenerations.state, 'ready'),
          eq(sessionCoverGenerations.failureCategory, 'account_not_ready'),
        ),
      ),
    )
    .orderBy(desc(sessionCoverGenerations.settledAt))
    .limit(1);
  if (!row?.settledAt) return null;
  return {
    providerKey: row.providerKey,
    accountNotReady: row.failureCategory === 'account_not_ready',
    settledAt: row.settledAt,
  };
}

/**
 * The provider-facing fields every frozen attempt persists identically —
 * shared by the initial insert and the reserved-row plan application so the
 * two write paths cannot drift.
 */
export interface FrozenAttemptFields {
  plan: SessionCoverPlanRecord;
  planVersion: string;
  promptVersion: string;
  planHash: string;
  promptHash: string;
  fingerprint: Record<string, string>;
  providerKey: string;
  model: string;
  capabilitySnapshot: Record<string, unknown>;
  capabilityDowngrades?: string[];
  retryPolicy: Record<string, unknown>;
  selectedReferences: SessionCoverSelectedReference[];
  seed?: string;
  maxSafeRetries?: number;
}

export interface PlanSessionCoverInput extends FrozenAttemptFields {
  id: string;
  ownerUserId: string;
  activitySessionId: string;
  idempotencyKey: string;
  coverImageId: string;
  storageKey: string;
  initialState?: SessionCoverGenerationRow['state'];
  trigger?: SessionCoverGenerationRow['trigger'];
  failureCategory?: string;
  settledAt?: Date;
}

export type PlanCoverGenerationFields = Omit<PlanSessionCoverInput, 'activitySessionId'>;

/**
 * Insert a generation attempt for one subject. Returns null when the partial
 * live-row unique index rejects it — another live attempt already exists for
 * the subject, and duplicate work must observe that one as pending rather
 * than double-spend.
 */
export async function planCoverGenerationForSubject(
  db: DbOrTx,
  subject: CoverLedgerSubject,
  input: PlanCoverGenerationFields,
): Promise<SessionCoverGenerationRow | null> {
  const [row] = await db
    .insert(sessionCoverGenerations)
    .values({
      ...input,
      ...subjectValues(subject),
      state: input.initialState ?? 'planned',
      trigger: input.trigger ?? 'initial',
      possiblyPaid: false,
      safeRetryCount: 0,
      maxSafeRetries: input.maxSafeRetries ?? 1,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Insert a Session generation attempt; see `planCoverGenerationForSubject`. */
export async function planSessionCoverGeneration(
  db: DbOrTx,
  input: PlanSessionCoverInput,
): Promise<SessionCoverGenerationRow | null> {
  const { activitySessionId, ...fields } = input;
  return planCoverGenerationForSubject(db, sessionLedgerSubject(activitySessionId), fields);
}

/**
 * The placeholder plan/provider fields every reserved (user-requested, not yet
 * worker-planned) attempt persists; the worker overwrites them when it freezes
 * the real plan.
 */
export function reservedCoverAttemptFields(
  plan: SessionCoverPlanRecord,
): Pick<
  PlanCoverGenerationFields,
  | 'plan'
  | 'planVersion'
  | 'promptVersion'
  | 'planHash'
  | 'promptHash'
  | 'fingerprint'
  | 'providerKey'
  | 'model'
  | 'capabilitySnapshot'
  | 'retryPolicy'
  | 'selectedReferences'
  | 'initialState'
  | 'trigger'
> {
  return {
    plan,
    planVersion: 'reserved',
    promptVersion: 'reserved',
    planHash: 'reserved',
    promptHash: 'reserved',
    fingerprint: {},
    providerKey: 'reserved',
    model: 'reserved',
    capabilitySnapshot: {},
    retryPolicy: {},
    selectedReferences: [],
    initialState: 'reserved',
    trigger: 'user_regenerate',
  };
}

export interface ReserveSessionCoverRegenerationInput {
  id: string;
  ownerUserId: string;
  activitySessionId: string;
  coverImageId: string;
  storageKey: string;
  /** Raw user art direction, frozen privately into the attempt (never logged). */
  userGuidance?: string;
  /** LLM-enhanced art direction that replaces the raw text when enhancement ran. */
  effectiveGuidance?: string;
  enhancementApplied?: boolean;
}

/**
 * Reserve a user-triggered regeneration attempt. The plan is a placeholder —
 * the worker freezes the real plan (capabilities, references, style grammar)
 * when it picks the attempt up — but the user's guidance is frozen here, at
 * request time. Returns null when the session already has a live attempt.
 */
export async function reserveSessionCoverRegeneration(
  db: DbOrTx,
  input: ReserveSessionCoverRegenerationInput,
): Promise<SessionCoverGenerationRow | null> {
  return planCoverGenerationForSubject(db, sessionLedgerSubject(input.activitySessionId), {
    id: input.id,
    ownerUserId: input.ownerUserId,
    ...reservedCoverAttemptFields(
      emptySessionCoverPlan({
        ...(input.userGuidance === undefined ? {} : { userGuidance: input.userGuidance }),
        ...(input.effectiveGuidance === undefined
          ? {}
          : { effectiveGuidance: input.effectiveGuidance }),
        ...(input.enhancementApplied === undefined
          ? {}
          : { enhancementApplied: input.enhancementApplied }),
      }),
    ),
    idempotencyKey: `session-cover:regen:${input.id}`,
    coverImageId: input.coverImageId,
    storageKey: input.storageKey,
  });
}

export interface PlanReservedSessionCoverInput extends FrozenAttemptFields {
  ownerUserId: string;
  id: string;
  state: SessionCoverGenerationRow['state'];
  failureCategory?: string;
  settledAt?: Date;
  updatedAt: Date;
}

/**
 * Freeze the worker-built plan onto a reserved attempt (or settle it terminally
 * when planning/admission refused). Guarded on `reserved` so a raced pickup
 * plans an attempt at most once; returns whether THIS call applied.
 */
export async function planReservedSessionCoverGeneration(
  db: DbOrTx,
  args: PlanReservedSessionCoverInput,
): Promise<boolean> {
  const { ownerUserId, id, ...patch } = args;
  const updated = await db
    .update(sessionCoverGenerations)
    .set({ ...patch, seed: patch.seed ?? null })
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, ownerUserId),
        eq(sessionCoverGenerations.id, id),
        eq(sessionCoverGenerations.state, 'reserved'),
      ),
    )
    .returning({ id: sessionCoverGenerations.id });
  return updated.length > 0;
}

/**
 * Patch a ledger row (optionally guarded by `expectedStates`). Drizzle omits
 * `undefined` fields from a SET clause, so an argument the caller leaves out keeps
 * its stored value; returns whether THIS call matched a row.
 */
export async function updateSessionCoverGeneration(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    id: string;
    state: SessionCoverGenerationRow['state'];
    possiblyPaid?: boolean;
    failureCategory?: string | null;
    costUsd?: number | null;
    providerOperationId?: string | null;
    submissionDisposition?: string;
    safeRetryCount?: number;
    capabilityDowngrades?: string[];
    submittedAt?: Date | null;
    settledAt?: Date | null;
    updatedAt?: Date;
    expectedStates?: SessionCoverGenerationRow['state'][];
  },
): Promise<boolean> {
  const updated = await db
    .update(sessionCoverGenerations)
    .set({
      state: args.state,
      possiblyPaid: args.possiblyPaid,
      failureCategory: args.failureCategory,
      costUsd: args.costUsd,
      providerOperationId: args.providerOperationId,
      submissionDisposition: args.submissionDisposition,
      safeRetryCount: args.safeRetryCount,
      capabilityDowngrades: args.capabilityDowngrades,
      submittedAt: args.submittedAt,
      settledAt: args.settledAt,
      updatedAt: args.updatedAt ?? new Date(),
    })
    .where(
      and(
        eq(sessionCoverGenerations.ownerUserId, args.ownerUserId),
        eq(sessionCoverGenerations.id, args.id),
        ...(args.expectedStates
          ? [inArray(sessionCoverGenerations.state, args.expectedStates)]
          : []),
      ),
    )
    .returning({ id: sessionCoverGenerations.id });
  return updated.length > 0;
}

export interface AgedSessionCoverGenerationId {
  id: string;
  ownerUserId: string;
  /** Exactly one of the two subjects is set (a Session or a Playlist attempt). */
  activitySessionId: string | null;
  playlistId: string | null;
  /** The aged attempt's trigger — regenerations resolve providers prompt-driven. */
  trigger: string;
}

export async function listAgedSessionCoverGenerationIds(
  db: DbOrTx,
  args: { updatedBefore: Date; limit?: number },
): Promise<AgedSessionCoverGenerationId[]> {
  return db
    .select({
      id: sessionCoverGenerations.id,
      ownerUserId: sessionCoverGenerations.ownerUserId,
      activitySessionId: sessionCoverGenerations.activitySessionId,
      playlistId: sessionCoverGenerations.playlistId,
      trigger: sessionCoverGenerations.trigger,
    })
    .from(sessionCoverGenerations)
    .where(
      and(
        inArray(sessionCoverGenerations.state, ['reserved', 'planned', 'submitting', 'storing']),
        lte(sessionCoverGenerations.updatedAt, args.updatedBefore),
      ),
    )
    .orderBy(asc(sessionCoverGenerations.updatedAt))
    .limit(Math.max(1, Math.min(args.limit ?? 25, 100))) as Promise<AgedSessionCoverGenerationId[]>;
}

/**
 * Ledger rows that count as (possible) cover spend in the window. The window key
 * is when the money moved: `submitted_at` for an attempt that reached the
 * provider, creation time for one still holding a reservation — an attempt
 * reserved before midnight and submitted after it belongs to the day it was paid
 * for. `session_cover_generations_spend_window_idx` indexes exactly this
 * expression; keep the two byte-identical or the count scans the whole ledger.
 */
function reservedOrPossiblyPaidLedgerCondition(since: Date) {
  return and(
    sql`coalesce(${sessionCoverGenerations.submittedAt}, ${sessionCoverGenerations.createdAt}) >= ${since}`,
    or(
      eq(sessionCoverGenerations.possiblyPaid, true),
      inArray(sessionCoverGenerations.state, ['reserved', 'planned', 'submitting', 'storing']),
    ),
  );
}

/** The ledger leg of `countCoverSpendByOwner`'s one-statement union, per owner. */
export function reservedOrPossiblyPaidLedgerRowsByOwnerQuery(db: DbOrTx, since: Date) {
  return db
    .select({
      ownerUserId: sessionCoverGenerations.ownerUserId,
      value: sql<number>`count(*)::int`,
    })
    .from(sessionCoverGenerations)
    .where(reservedOrPossiblyPaidLedgerCondition(since))
    .groupBy(sessionCoverGenerations.ownerUserId);
}

/**
 * The conservative cover count in one spend scope: live
 * reservations plus every possibly-paid attempt. `excludeGenerationId` leaves
 * one attempt out — its own admission check must not count itself — and applies
 * in either scope.
 */
export async function countReservedOrPossiblyPaidCovers(
  db: DbOrTx,
  args: { scope: SpendScope; since: Date; excludeGenerationId?: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessionCoverGenerations)
    .where(
      and(
        spendScopeCondition(args.scope, sessionCoverGenerations.ownerUserId),
        reservedOrPossiblyPaidLedgerCondition(args.since),
        ...(args.excludeGenerationId
          ? [ne(sessionCoverGenerations.id, args.excludeGenerationId)]
          : []),
      ),
    );
  return row?.count ?? 0;
}
