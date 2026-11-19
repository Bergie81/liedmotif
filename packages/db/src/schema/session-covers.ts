import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, updatedAt } from './_columns';
import { user } from './auth';
import { sessionCoverGenerationState, sessionCoverTrigger } from './enums';
import { playlists } from './playlists';
import { activitySessions } from './sessions';

/**
 * Ledger states that represent in-flight work. At most one live attempt may
 * exist per (owner, session) — enforced by the partial unique index below —
 * while terminal attempts accumulate as the session's cover history.
 */
export const SESSION_COVER_LIVE_STATES = ['reserved', 'planned', 'submitting', 'storing'] as const;

export interface SessionCoverPlanRecord {
  sessionName: string;
  coverConcept: string | null;
  selectedStyle: string;
  resolvedStyle: string;
  customDefinition: string | null;
  styleFallbackReason: string | null;
  concreteScene: string;
  semanticCueIds: string[];
  conceptMode: string;
  subjectFamily: string;
  composition: string;
  palette: string;
  material: string;
  lighting: string;
  referenceTreatment: string | null;
  /** Private ordered Person identities frozen before cover-provider I/O. */
  selectedPersonIds?: string[];
  /** Raw user art direction for a regeneration attempt (private, never logged). */
  userGuidance?: string;
  /** The effective art direction the prompt used (LLM-enhanced when enhancement ran). */
  effectiveGuidance?: string;
  /** Whether LLM prompt enhancement produced `effectiveGuidance` for this attempt. */
  enhancementApplied?: boolean;
  /** The text LLM's reading of whether a regeneration's typed art direction
   *  puts the listener in the picture ("me dancing with Jonas", any language);
   *  absent without a reading. Frozen at reservation like the guidance. */
  wishIncludesListener?: boolean;
  /** The sheet's People switch for THIS attempt: true asks for Person
   *  reference photos, false sends none. Absent on a Playlist attempt sends
   *  none; on a Session attempt it keeps the Session's own rules. Frozen at
   *  reservation so re-planning, retries, and recovery all honor the same
   *  request. */
  usePeopleReferences?: boolean;
  prompt: string;
  exclusions: string[];
  altText: string;
  candidateCount: number;
  diversityRelaxedAxes?: string[];
}

/**
 * What a user regeneration request freezes onto its attempt at reservation and
 * the worker's own planning cannot reconstruct: the art direction, its
 * enhancement and listener reading, and the People switch.
 */
export type CoverRequestProvenance = Pick<
  SessionCoverPlanRecord,
  | 'userGuidance'
  | 'effectiveGuidance'
  | 'enhancementApplied'
  | 'wishIncludesListener'
  | 'usePeopleReferences'
>;

/**
 * A structurally valid but empty plan — the placeholder persisted before a real
 * plan is frozen (a reserved regeneration attempt) or when planning itself
 * refused (the terminal-fallback record).
 */
export function emptySessionCoverPlan(
  overrides: Partial<SessionCoverPlanRecord> = {},
): SessionCoverPlanRecord {
  return {
    sessionName: '',
    coverConcept: null,
    selectedStyle: 'auto',
    resolvedStyle: 'auto',
    customDefinition: null,
    styleFallbackReason: null,
    concreteScene: '',
    semanticCueIds: [],
    conceptMode: '',
    subjectFamily: '',
    composition: '',
    palette: '',
    material: '',
    lighting: '',
    referenceTreatment: null,
    prompt: '',
    exclusions: [],
    altText: '',
    candidateCount: 0,
    ...overrides,
  };
}

/**
 * Why a frozen Person-reference selection refuses its attempt before any paid
 * call: the endpoint cannot carry the references, or the owner's hard privacy
 * opt-out blocks a selection they explicitly asked for.
 */
export type CoverReferenceRefusal = 'references_unsupported' | 'privacy_rejected';

export interface SessionCoverSelectedReference {
  id: string;
  role: 'subject' | 'style';
  /** Optional so persisted ledgers without a Person association remain readable. */
  personId?: string;
}

export const sessionCoverGenerations = pgTable(
  'session_cover_generations',
  {
    id: pk(),
    // Nullable + set-null, like `generation_requests`: the row is cover spend
    // and must outlive a deleted Member, or deleting them would hand their
    // window's covers back to the Members Pool. `deleteMember`
    // erases the row's private plan before the owner goes null.
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    activitySessionId: uuid('activity_session_id'),
    // Playlist cover attempts ride the same ledger and full cover
    // machinery. Exactly one of activitySessionId / playlistId is set per row
    // while its subject exists. Deleting the subject only clears the edge: the
    // row is the spend record the cover budgets count.
    playlistId: uuid('playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    state: sessionCoverGenerationState('state').notNull(),
    trigger: sessionCoverTrigger('trigger').notNull().default('initial'),
    possiblyPaid: boolean('possibly_paid').notNull().default(false),
    plan: jsonb('plan').$type<SessionCoverPlanRecord>().notNull(),
    planVersion: text('plan_version').notNull(),
    promptVersion: text('prompt_version').notNull(),
    planHash: text('plan_hash').notNull(),
    promptHash: text('prompt_hash').notNull(),
    fingerprint: jsonb('fingerprint').$type<Record<string, string>>().notNull(),
    providerKey: text('provider_key').notNull(),
    model: text('model').notNull(),
    capabilitySnapshot: jsonb('capability_snapshot').$type<Record<string, unknown>>().notNull(),
    capabilityDowngrades: jsonb('capability_downgrades')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    idempotencyKey: text('idempotency_key').notNull(),
    retryPolicy: jsonb('retry_policy').$type<Record<string, unknown>>().notNull(),
    selectedReferences: jsonb('selected_references')
      .$type<SessionCoverSelectedReference[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    seed: text('seed'),
    coverImageId: uuid('cover_image_id').notNull(),
    storageKey: text('storage_key').notNull(),
    failureCategory: text('failure_category'),
    costUsd: doublePrecision('cost_usd'),
    providerOperationId: text('provider_operation_id'),
    submissionDisposition: text('submission_disposition').notNull().default('not_started'),
    safeRetryCount: integer('safe_retry_count').notNull().default(0),
    maxSafeRetries: integer('max_safe_retries').notNull().default(1),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('session_cover_generations_owner_session_live_unique')
      .on(table.ownerUserId, table.activitySessionId)
      .where(sql`state in ('reserved', 'planned', 'submitting', 'storing')`),
    uniqueIndex('session_cover_generations_owner_playlist_live_unique')
      .on(table.ownerUserId, table.playlistId)
      .where(sql`state in ('reserved', 'planned', 'submitting', 'storing')`),
    index('session_cover_generations_owner_created_idx').on(table.ownerUserId, table.createdAt),
    // Cover-spend admission counts the window on when the money moved —
    // `coalesce(submitted_at, created_at)` — which no plain column index can
    // serve. The Members Pool scope narrows by "owner is not an admin" rather
    // than by owner, so its count, and the per-owner grouped readout behind the
    // admin surfaces, had nothing but a full ledger scan. The window leads, so it
    // bounds the scan whether or not the query also narrows by owner; the
    // expression must stay byte-identical to
    // `reservedOrPossiblyPaidLedgerCondition` in `generation-ledger-repo` or the
    // planner will not match it.
    index('session_cover_generations_spend_window_idx').on(
      sql`coalesce(${table.submittedAt}, ${table.createdAt})`,
      table.ownerUserId,
    ),
    // RI cascade probe on playlist delete (the partial live-unique index above
    // cannot serve it — terminal states must be found too).
    index('session_cover_generations_playlist_idx').on(table.playlistId),
    // Every-minute aged-attempt sweep: live-state rows by staleness.
    index('session_cover_generations_live_updated_idx')
      .on(table.updatedAt)
      .where(sql`state in ('reserved', 'planned', 'submitting', 'storing')`),
    index('session_cover_generations_owner_state_idx').on(table.ownerUserId, table.state),
    uniqueIndex('session_cover_generations_cover_id_unique').on(table.coverImageId),
    uniqueIndex('session_cover_generations_storage_key_unique').on(table.storageKey),
    uniqueIndex('session_cover_generations_idempotency_key_unique').on(table.idempotencyKey),
    foreignKey({
      columns: [table.ownerUserId, table.activitySessionId],
      foreignColumns: [activitySessions.ownerUserId, activitySessions.id],
      name: 'session_cover_generations_owner_session_fk',
    }),
  ],
);
