// Generation units: GenerationRequest (Liedmotif's intent to generate, cost-
// checked before spend) and ProviderJob (the tracked, paid provider call behind
// it — one per request).
//
// CIRCULAR FK: `generation_requests.activitySessionId` -> `activity_sessions.id`
// closes a cycle (activity_sessions -> tracks -> generation_requests ->
// activity_sessions). It is broken with a nullable column + the `AnyPgColumn`
// return-type annotation on the lazy `.references()` callback (Drizzle's
// documented self/circular-reference pattern). Drizzle Kit emits every FK as a
// post-`CREATE TABLE` `ALTER TABLE ADD CONSTRAINT`, so the cycle applies cleanly.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  doublePrecision,
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
import {
  generationSource,
  providerNormalizedStatus,
  providerSubmitState,
  providerType,
  spendSubmitStateSqlList,
} from './enums';
import { activitySessions } from './sessions';
import type { CostEstimate, StructuredControls, StyleSnapshot } from './types';

export const generationRequests = pgTable(
  'generation_requests',
  {
    id: pk(),
    // Nullable + set-null (unlike every content table): requests are the SPEND
    // LEDGER and must outlive their owner, or delete-and-recreate would reset
    // the Members Pool window counts. The Pool predicate counts a
    // null owner as non-admin, so an orphaned row keeps counting to rollover.
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    // Nullable + set-null: a standalone request can outlive its session row.
    activitySessionId: uuid('activity_session_id').references(
      (): AnyPgColumn => activitySessions.id,
      { onDelete: 'set null' },
    ),
    source: generationSource('source').notNull(),
    // The session's prompt history frozen at submit time, bounded for Track
    // Data — a later Change Vibe never rewrites what these Tracks came from.
    // Null on legacy rows, which fall back to the session's live value.
    userPrompt: text('user_prompt'),
    structuredControls: jsonb('structured_controls').$type<StructuredControls>(),
    expandedPrompt: text('expanded_prompt'),
    stylePrompt: text('style_prompt'),
    // The request's zero-based index within its session, recorded at submit so
    // materialization can title one call's sibling tracks distinctly (per-track
    // ordinal = index * requestedTrackCount + k). Null on standalone requests.
    titleSeed: integer('title_seed'),
    // The FIRST track's display title, persisted the moment a provider poll
    // reports per-track data (the text stage) — before any playable audio
    // exists — so the queue endpoint can tease "Composing '<title>'…" during
    // a cold start. Written once (derivation makes it stable anyway); obeys
    // the same sibling-title derivation materialization uses, so the tease
    // always matches the track's final display title.
    earlyTrackTitle: text('early_track_title'),
    // Generation-time BLEND IDENTITY: what this
    // request was generated AGAINST, written at submit from the snapshot it
    // compiled (or copied from the original request on a Dislike reroll). All
    // three are nullable — legacy/pre-plan rows stay null, and a NULL identity
    // always forces a plain edge in the player. `styleRevision` snapshots
    // `activity_sessions.style_revision` at submit, so old-vibe tracks queued
    // across a Change Vibe are distinguishable from new-vibe ones.
    styleRevision: integer('style_revision'),
    targetBpm: doublePrecision('target_bpm'),
    targetKey: text('target_key'),
    // The VALIDATED Style Snapshot this request compiled from (its full provider
    // compilation context — vocal language/lyric tails, negative terms, seed
    // parameters). A Dislike fresh-call reroll re-runs the SAME compiler over
    // this snapshot with a fresh request index, so the replacement keeps the old
    // vibe verbatim while its hidden-seed variation rotates. Null on
    // legacy/pre-plan rows → the reroll falls back to
    // the stored `stylePrompt` (degraded but still old-vibe).
    styleSnapshot: jsonb('style_snapshot').$type<StyleSnapshot>(),
    negativePrompt: text('negative_prompt'),
    promptFingerprint: text('prompt_fingerprint'),
    providerType: providerType('provider_type').notNull(),
    providerKey: text('provider_key').notNull(),
    requestedTrackCount: integer('requested_track_count').notNull().default(2),
    // Paid requests begin `awaiting_results` and become `materialized` after
    // the full final provider response is persisted. This batch-settlement
    // marker survives Track deletion; duration-limited admission must wait
    // through the provider-ready/materialization gap. `failed` records terminal
    // provider failure, and legacy requests retain their diagnostic values.
    status: text('status').notNull(),
    costEstimate: jsonb('cost_estimate').$type<CostEstimate>(),
    errorCode: text('error_code'),
    errorMessageSafe: text('error_message_safe'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('generation_requests_owner_user_id_idx').on(table.ownerUserId),
    index('generation_requests_activity_session_id_idx').on(table.activitySessionId),
    // Diagnostics feed: newest terminal failures. `status` is a text column;
    // 'failed' is one of its written values (see the column comment).
    index('generation_requests_failed_updated_idx')
      .on(sql`${table.updatedAt} desc`)
      .where(sql`${table.status} = 'failed'`),
  ],
);

export const providerJobs = pgTable(
  'provider_jobs',
  {
    id: pk(),
    generationRequestId: uuid('generation_request_id')
      .notNull()
      .references((): AnyPgColumn => generationRequests.id, { onDelete: 'cascade' }),
    providerType: providerType('provider_type').notNull(),
    providerKey: text('provider_key').notNull(),
    // Null until the provider confirms submit and returns a taskId.
    providerTaskId: text('provider_task_id'),
    submitState: providerSubmitState('submit_state').notNull().default('not_submitted'),
    lastSubmitAttemptAt: timestamp('last_submit_attempt_at', { withTimezone: true }),
    providerStatus: text('provider_status'),
    normalizedStatus: providerNormalizedStatus('normalized_status').notNull().default('queued'),
    // Redacted by the provider layer (no secrets/URLs persisted).
    rawRequest: jsonb('raw_request'),
    rawResponse: jsonb('raw_response'),
    retryCount: integer('retry_count').notNull().default(0),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One paid provider task per generation request (money-idempotency).
    uniqueIndex('provider_jobs_generation_request_id_unique').on(table.generationRequestId),
    // Provider's own task id is unique per provider, once it exists.
    uniqueIndex('provider_jobs_provider_key_task_id_unique')
      .on(table.providerKey, table.providerTaskId)
      .where(sql`${table.providerTaskId} is not null`),
    index('provider_jobs_normalized_status_idx').on(table.normalizedStatus),
    index('provider_jobs_next_poll_at_idx').on(table.nextPollAt),
    // Every-minute missing-tracks sweep: ready jobs inside the recency bound.
    index('provider_jobs_ready_updated_idx')
      .on(table.updatedAt)
      .where(sql`${table.normalizedStatus} = 'ready' and ${table.providerTaskId} is not null`),
    // Spend-window counts (`countTasksInWindow`): submitted jobs by window
    // start, evaluated per Member submit while holding the Pool lock. The
    // predicate is built from `SPEND_SUBMIT_STATES` so the index and the query
    // it serves cannot come to disagree about what spend is.
    index('provider_jobs_spend_window_idx')
      .on(table.createdAt)
      .where(sql`${table.submitState} in (${sql.raw(spendSubmitStateSqlList)})`),
    // Diagnostics feed: newest jobs that reached the provider.
    index('provider_jobs_submitted_at_idx')
      .on(sql`${table.lastSubmitAttemptAt} desc`)
      .where(sql`${table.providerTaskId} is not null`),
  ],
);
