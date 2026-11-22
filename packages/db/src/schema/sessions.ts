// The Session aggregate (`ActivitySession`) and its server-authoritative Queue
// (`activity_session_queue_items`, the single source of truth for what plays
// next).
//
// CIRCULAR FKs: `currentTrackId` -> tracks, `currentQueueItemId` -> queue items
// (defined below in this same file), and queue items -> sessions/tracks/requests
// all close cycles; every cross-/self-table FK uses the nullable + `AnyPgColumn`
// lazy-`.references()` pattern so inserts can break the cycle (create the session
// with null pointers, then back-fill) and Drizzle Kit emits valid SQL.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { CoverStylePreset } from '@liedmotif/shared';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';
import { coverImages } from './covers';
import {
  activitySessionStatus,
  coverStyle,
  queueItemState,
  sessionEndReason,
  sessionGenerationStatus,
  sessionMode,
} from './enums';
import { generationRequests } from './generation';
import { tracks } from './tracks';
import type { StructuredControls, StyleSnapshot, TasteProfileSnapshot } from './types';

export const activitySessions = pgTable(
  'activity_sessions',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    // User-editable Name, derived at creation: LLM-proposed when a text LLM is
    // configured, deterministic (prompt/snapshot composition) otherwise.
    title: text('title'),
    // The on-disk audio folder segment (`<title-slug>-<id8>`), claimed once at
    // the session's FIRST final-audio download so every later download joins the
    // same folder — a Rename or Change Vibe can never split a
    // session's files across folders. Null until something downloads.
    audioFolderSegment: text('audio_folder_segment'),
    coverConcept: text('cover_concept'),
    // The text LLM's pick of the cover preset Auto resolves to, written with
    // `coverConcept` when a Session starts and frozen after (Change Vibe and
    // Rename keep it). Null when no text LLM answered with a valid preset.
    autoCoverStyle: coverStyle('auto_cover_style').$type<CoverStylePreset>(),
    // The session's running free-text intent: the creation prompt, extended by
    // each Change Vibe text with an empty line between them. Null for a session
    // that has only ever been steered by structured controls.
    userPrompt: text('user_prompt'),
    structuredControls: jsonb('structured_controls').$type<StructuredControls>(),
    activeTasteProfileSnapshot: jsonb(
      'active_taste_profile_snapshot',
    ).$type<TasteProfileSnapshot>(),
    sessionStyleSnapshot: jsonb('session_style_snapshot').$type<StyleSnapshot>(),
    // Monotonic Style-Snapshot revision. Starts
    // at 1; Change Vibe increments it IN THE SAME UPDATE that replaces the
    // snapshot (atomic — there is never a window where a new snapshot is visible
    // with the old revision). Submits stamp it onto `generation_requests` so the
    // player can force a plain edge across a vibe boundary.
    styleRevision: integer('style_revision').notNull().default(1),
    // Switch-now Change Vibe: when set, cut over to the first playable track
    // whose styleRevision >= this value (setting aside queued older-revision
    // items), then clear. Null = play buffered tracks out. Cleared by a plain
    // (untoggled) Change Vibe and by session stop.
    vibeSwitchRevision: integer('vibe_switch_revision'),
    // The Session Cover (a Session has a Name and Cover, derived without a text LLM).
    coverImageId: uuid('cover_image_id').references((): AnyPgColumn => coverImages.id, {
      onDelete: 'set null',
    }),
    // User-selected generated-cover art-direction lane (default `auto` = pipeline
    // picks). Cover-only: never feeds the music Style Snapshot or track prompts.
    coverStyle: coverStyle('cover_style').notNull().default('auto'),
    // Private user `Custom style` definition. It is populated only when the
    // authoritative style is `custom`.
    coverStyleHint: text('cover_style_hint'),
    // Deterministically normalized Custom definition, persisted with creation
    // metadata and reused verbatim by cover planning.
    coverStyleHintNormalized: text('cover_style_hint_normalized'),
    coverStyleFallbackReason: text('cover_style_fallback_reason'),
    // Cover-source choice: standard covers come from the music provider's own
    // cover-art endpoint (no style control, no extra cost) instead of the
    // styled image-provider pipeline. Set at creation only; `coverStyle` stays
    // stored regardless so a later user regeneration can still style.
    useStandardCover: boolean('use_standard_cover').notNull().default(false),
    // Start-without-profile: the owner's own details (listener profile, own
    // About, owner Person and photos) stay out of this session's LLM prompts AND
    // its generated cover; the other People its request names stay in. Set at
    // creation only; Change Vibe re-derivations read it from this row.
    skipProfile: boolean('skip_profile').notNull().default(false),
    // The text LLM read the request as putting the listener in its own scene
    // ("me, Jonas and Clara on the moon"), so the generated cover treats the
    // owner Person as named. Only an expansion can say so; Change Vibe may
    // revise it.
    includesListener: boolean('includes_listener').notNull().default(false),
    status: activitySessionStatus('status').notNull().default('active'),
    // Generation policy — the sole authority over
    // automatic top-ups. Every new Session starts in `keep_going`;
    // written by API routes (user intent), never the worker.
    sessionMode: sessionMode('session_mode').notNull().default('keep_going'),
    // Generation-controller status: the session stays `active` while this
    // surfaces cost-limit Session Repeat / provider blocks. Written by the worker;
    // Resume resets it to `ok`.
    generationStatus: sessionGenerationStatus('generation_status').notNull().default('ok'),
    // Why a Stopped session ended (user stop, supersede, idle auto-stop, bounded
    // complete); null while active.
    endReason: sessionEndReason('end_reason'),
    // Safe, user-facing message for the current `generationStatus`.
    statusMessageSafe: text('status_message_safe'),
    // Which bound a Member's `repeat_cost_limit` names: 'member'
    // (their personal budget) or 'pool' (the shared Members Pool). Null for the
    // Admin and for every non-cost-limited status — the scope must be readable
    // from the payload, never inferred from which number looks smaller.
    generationStatusScope: text('generation_status_scope').$type<'member' | 'pool'>(),
    targetDurationMinutes: integer('target_duration_minutes'),
    currentTrackId: uuid('current_track_id').references((): AnyPgColumn => tracks.id, {
      onDelete: 'set null',
    }),
    currentQueueItemId: uuid('current_queue_item_id').references(
      (): AnyPgColumn => activitySessionQueueItems.id,
      { onDelete: 'set null' },
    ),
    activePlaybackClientId: text('active_playback_client_id'),
    lastPlaybackPositionSeconds: doublePrecision('last_playback_position_seconds'),
    // Most-recent playback report. Also orders My Sessions by recency.
    lastPlaybackReportAt: timestamp('last_playback_report_at', { withTimezone: true }),
    // Unused: the idle sweep (`endReason='idle_timeout'`) applies the instance
    // `usageLimits.idleAutoStopAfterMinutes`, so Settings → Limits reaches running
    // Sessions. Nothing writes this column.
    idleAutoStopAfterMinutes: integer('idle_auto_stop_after_minutes').notNull().default(15),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    // When Resume last re-activated this session (null until first resumed).
    lastResumedAt: timestamp('last_resumed_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    // Pinned Session; null = not pinned. The instant orders the
    // Pinned section (newest pin first). Capped per owner at MAX_PINNED_SESSIONS.
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    // A Session delete asked while provider or cover work was still in flight:
    // the owner can no longer list, search, pin, resume or play the session, and
    // the worker finishes the delete once that work settles (a late Track would
    // otherwise orphan its audio).
    deleteRequestedAt: timestamp('delete_requested_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('activity_sessions_owner_user_id_idx').on(table.ownerUserId),
    // RI set-null probes: track delete and queue-item cascade each check the
    // current-pointer columns per deleted row; cover reclamation probes the
    // cover pointer (partial — most sessions reference no custom cover).
    index('activity_sessions_current_track_idx').on(table.currentTrackId),
    index('activity_sessions_current_queue_item_idx').on(table.currentQueueItemId),
    index('activity_sessions_cover_image_id_idx')
      .on(table.coverImageId)
      .where(sql`${table.coverImageId} is not null`),
    // Cover reclamation asks "does the session this cover names still exist?"
    // against the JSON provenance, which stores the id as text — a comparison
    // the uuid primary key cannot serve. Three in-transaction delete paths and
    // the hourly sweep run it, so without this every one of them sequential-
    // scans the whole table once per candidate cover.
    index('activity_sessions_id_text_idx').on(sql`(${table.id}::text)`),
    // My Sessions keyset pagination (and /api/search session ordering): the
    // expression must stay byte-identical to `sessionLastActiveExpr` in
    // session-list-repo or the planner will not match it.
    index('activity_sessions_owner_last_active_idx')
      .on(
        table.ownerUserId,
        sql`(coalesce(${table.lastPlaybackReportAt}, ${table.stoppedAt}, ${table.lastResumedAt}, ${table.startedAt})) desc`,
        sql`${table.id} desc`,
      )
      .where(sql`${table.status} = 'stopped'`),
    // The every-minute deferred-delete sweep reads only the pending few.
    index('activity_sessions_delete_requested_idx')
      .on(table.deleteRequestedAt)
      .where(sql`${table.deleteRequestedAt} is not null`),
    // Invariant: at most one ACTIVE session per owner (partial unique).
    uniqueIndex('activity_sessions_one_active_per_owner')
      .on(table.ownerUserId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('activity_sessions_owner_id_unique').on(table.ownerUserId, table.id),
    check(
      'activity_sessions_authoritative_cover_style',
      sql`(
        (${table.coverStyle} = 'custom' and btrim(coalesce(${table.coverStyleHint}, '')) <> '')
        or
        (${table.coverStyle} <> 'custom' and ${table.coverStyleHint} is null and ${table.coverStyleHintNormalized} is null)
      )`,
    ),
  ],
);

export const activitySessionQueueItems = pgTable(
  'activity_session_queue_items',
  {
    id: pk(),
    activitySessionId: uuid('activity_session_id')
      .notNull()
      .references((): AnyPgColumn => activitySessions.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id').references((): AnyPgColumn => tracks.id, { onDelete: 'set null' }),
    generationRequestId: uuid('generation_request_id').references(
      (): AnyPgColumn => generationRequests.id,
      { onDelete: 'set null' },
    ),
    position: integer('position').notNull(),
    state: queueItemState('state').notNull().default('planned'),
    vibeSwitchSetAside: boolean('vibe_switch_set_aside').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('queue_items_session_position_idx').on(table.activitySessionId, table.position),
    index('queue_items_state_idx').on(table.state),
    // RI set-null probe on generation-request delete (request cascade fans out
    // per deleted request row).
    index('queue_items_generation_request_id_idx').on(table.generationRequestId),
    // "Is this track live in a queue?" guard on Dislike/Delete/evict paths.
    // Partial: planned slots have no track yet and never match those lookups.
    index('queue_items_track_id_idx')
      .on(table.trackId)
      .where(sql`${table.trackId} is not null`),
    // Domain invariant: a given track is queued AT MOST ONCE per session. Partial so
    // the not-yet-attached `planned` slots (null trackId) are exempt. This is what
    // makes the worker's queue-item write concurrency-idempotent (`onConflictDoNothing`
    // on it) and keeps `countReadyAheadTracks` from being corrupted by duplicates.
    uniqueIndex('queue_items_session_track_unique')
      .on(table.activitySessionId, table.trackId)
      .where(sql`${table.trackId} is not null`),
  ],
);

/**
 * The repeat-one loop LEASE: one row per
 * (session, client) — each tab/device owns its OWN lease, so "another tab's
 * release cannot cancel a live hold it doesn't own" holds by construction and a
 * second tab's hold is genuinely independent (the sweep skips paid
 * prefill while ANY unexpired, unreleased lease exists). A lease (not a boolean
 * ping) because playback reports are fire-and-forget: `epoch` is monotonic per
 * client (reordering safety — a delayed renew can never resurrect a newer
 * release), and the row SURVIVES a release (`releasedAt` set, epoch retained)
 * precisely so that stale-epoch check still has something to compare against.
 * Expiry lapses a hold and prefill resumes — nothing in flight is ever cancelled.
 */
export const sessionLoopLeases = pgTable(
  'session_loop_leases',
  {
    activitySessionId: uuid('activity_session_id')
      .notNull()
      .references(() => activitySessions.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    // Monotonic per client (a ms timestamp in practice); compared only between
    // operations of the SAME clientId — different clients' epochs never meet.
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Set on an honored release; null while the hold is (potentially) live. A
    // lease is HELD iff `releasedAt is null AND expiresAt > now()`.
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.activitySessionId, table.clientId] })],
);
