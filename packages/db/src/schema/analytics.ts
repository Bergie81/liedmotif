// Personal analytics: a User's own listening to their own Tracks.
//
// One permanent row per playback occurrence, updated in place as progress
// arrives — never one row per ping. Rows are retained indefinitely and no
// retention job touches them. Nothing here holds a title, prompt, provider URL,
// credential, or About text: only timestamps, measured time, and the musical
// facts frozen from the Track at the first report.

import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';
import { user } from './auth';
import { vocalMode } from './enums';
import { activitySessions } from './sessions';
import { tracks } from './tracks';
import type { StyleSnapshot } from './types';

/** Credited milliseconds per 15-minute UTC bucket, keyed by `floor(epochMs / 900000)`. */
export type ListeningTimeBuckets = Record<string, number>;

export const listeningOccurrences = pgTable(
  'listening_occurrences',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    /** Client-minted identity of one playback occurrence; every report for it carries the same value. */
    occurrenceId: uuid('occurrence_id').notNull(),
    /** `tracks.analytics_id` at report time. Deliberately NOT a foreign key: it must outlive the Track. */
    analyticsTrackId: uuid('analytics_track_id').notNull(),
    // Live links, severed when the content goes; the totals stay.
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => activitySessions.id, { onDelete: 'set null' }),
    surface: text('surface').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastListenedAt: timestamp('last_listened_at', { withTimezone: true }).notNull(),
    /** Credited time: crossfade overlap is divided between its two Tracks. */
    listenedMs: integer('listened_ms').notNull().default(0),
    /** Time this Track itself was audibly playing, overlap undivided; decides `qualifiedAt`. */
    playedMs: integer('played_ms').notNull().default(0),
    /** `user`, `auto` or `loop`; null on rows recorded before origins were captured. */
    startOrigin: text('start_origin'),
    /**
     * Where the credited time fell, fine enough to split an occurrence across a
     * midnight in any timezone (every real UTC offset is a multiple of 15 minutes).
     */
    timeBuckets: jsonb('time_buckets')
      .$type<ListeningTimeBuckets>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Set once, when credited time first reached the play threshold. */
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    endReason: text('end_reason'),
    // Musical facts of the Track's generating style, frozen at the first report.
    genreTags: jsonb('genre_tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    energy: text('energy'),
    vocalMode: vocalMode('vocal_mode'),
    bpmEstimate: doublePrecision('bpm_estimate'),
    /** The sung language of the Track's generating style; null for instrumentals and undetected. */
    language: text('language'),
    /**
     * Whether learned taste may read this occurrence: personalization was on
     * when it began. Fixed at the first report, so turning personalization back
     * on never ingests what was heard while it was off.
     */
    tasteEligible: boolean('taste_eligible').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('listening_occurrences_owner_occurrence_unique').on(
      table.ownerUserId,
      table.occurrenceId,
    ),
    // Period reads: an occurrence can only contribute to a range it was still
    // being listened to in, and `qualified_at` never exceeds `last_listened_at`.
    index('listening_occurrences_owner_last_listened_idx').on(
      table.ownerUserId,
      table.lastListenedAt,
    ),
    // "Was this output ever heard": one probe per generated Track.
    index('listening_occurrences_owner_analytics_track_idx').on(
      table.ownerUserId,
      table.analyticsTrackId,
    ),
  ],
);

/**
 * The ledger of music actually produced: one permanent row per Track, written
 * in the transaction that first made it playable. It carries no title, prompt
 * or provider identity and holds only a severable link to the Track, so
 * deleting music never rewrites how much was generated.
 */
export const generationOutputs = pgTable(
  'generation_outputs',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    /** `tracks.analytics_id`. Deliberately NOT a foreign key: it must outlive the Track. */
    analyticsTrackId: uuid('analytics_track_id').notNull(),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    firstPlayableAt: timestamp('first_playable_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The final-audio download was given up on. The music model still produced
     * this Track, so this is a storage failure, never a generation failure.
     */
    storageFailedAt: timestamp('storage_failed_at', { withTimezone: true }),
    /**
     * Reconstructed from a Track that still existed when the ledger began. Such
     * rows undercount their era: Tracks deleted before then left no trace.
     */
    historical: boolean('historical').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('generation_outputs_analytics_track_unique').on(table.analyticsTrackId),
    index('generation_outputs_owner_first_playable_idx').on(
      table.ownerUserId,
      table.firstPlayableAt,
    ),
    index('generation_outputs_track_id_idx').on(table.trackId),
  ],
);

export const listeningPreferences = pgTable('listening_preferences', {
  ownerUserId: text('owner_user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /**
   * Every surface (Session, Playlist, preview) is recorded from this instant.
   * Listening before it is unknown, not zero.
   */
  collectionStartedAt: timestamp('collection_started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * When the owner last cleared their listening history. Listening begun at or
   * before it is never recorded again, however late its report arrives, and
   * nothing derived from listening may reach back past it.
   */
  historyClearedAt: timestamp('history_cleared_at', { withTimezone: true }),
  /** Learned taste is gathered and used only while this is on; stats never depend on it. */
  personalizeSuggestions: boolean('personalize_suggestions').notNull().default(true),
  /**
   * The learned-taste boundary, moved by Reset learned taste and by clearing
   * history. Taste reads no listening begun, and no evidence made, at or before it.
   */
  tasteResetAt: timestamp('taste_reset_at', { withTimezone: true }),
  /**
   * When existing Favorites and Playlist members were taken as starting
   * evidence. Set once and never cleared: after it, only new engagement teaches.
   */
  tasteSeededAt: timestamp('taste_seeded_at', { withTimezone: true }),
  /**
   * The personalization context a Surprise Me proposal is made under. Every
   * reset, clearing and Personalize suggestions change advances it, so a
   * proposal requested under an earlier value can never be stored.
   */
  proposalEpoch: integer('proposal_epoch').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const TASTE_EVIDENCE_KINDS = ['favorite', 'playlist', 'reroll'] as const;
export type TasteEvidenceKind = (typeof TASTE_EVIDENCE_KINDS)[number];

/**
 * What learned taste knows about a Track beyond listening: the owner's current
 * curation of it (`favorite` outranks `playlist`; a Track holds one row, so
 * Favorites' automatic membership is never a second credit) or that it was
 * rerolled. The musical facts are frozen here and the row carries no link to
 * the Track, so removing music leaves the taste it taught in place while
 * nothing can name what taught it.
 */
export const tasteEvidence = pgTable(
  'taste_evidence',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    /** `tracks.analytics_id`. Deliberately NOT a foreign key: it must outlive the Track. */
    analyticsTrackId: uuid('analytics_track_id').notNull(),
    kind: text('kind').$type<TasteEvidenceKind>().notNull(),
    genreTags: jsonb('genre_tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    energy: text('energy'),
    vocalMode: vocalMode('vocal_mode'),
    bpmEstimate: doublePrecision('bpm_estimate'),
    language: text('language'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('taste_evidence_owner_analytics_track_unique').on(
      table.ownerUserId,
      table.analyticsTrackId,
    ),
  ],
);

/** The fine-tune picks a proposal was made with — what Edit hands the normal creation form. */
export interface SurpriseProposalPicks {
  genres?: string[];
  energy?: 'low' | 'medium' | 'high';
  vocal?: 'instrumental' | 'vocal';
  language?: string;
}

/** Everything about a proposal that may leave the server. */
export interface SurpriseProposalPreview {
  title: string;
  mood: string;
  genres: string[];
  energy: 'low' | 'medium' | 'high';
  vocalMode: 'instrumental' | 'vocal';
  voiceGender: 'female' | 'male' | null;
  language: string | null;
  /** The Session duration target the request asks for; absent on proposals made before it was planned. */
  durationMinutes?: number;
  /** The curated situation or topic the proposal was planned from (never personal), so Try another can skip it. */
  situation?: string;
}

/**
 * The owner's one pending Surprise Me proposal: a validated Style Snapshot
 * (musical style plus lyric direction) waiting to be started, edited, replaced
 * or dismissed. It is not a Session and buys nothing. `snapshot` and
 * `coverConcept` may carry lyric notes drawn from the owner's About and stay
 * server-side; only `preview`, `intent` and `picks` are shown.
 */
export const surpriseProposals = pgTable(
  'surprise_proposals',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    adventurous: boolean('adventurous').notNull(),
    /** Made under Start without profile: no profile or People context was read. */
    skipProfile: boolean('skip_profile').notNull(),
    /** A text LLM wrote it; false is the deterministic no-LLM proposal. */
    llmGenerated: boolean('llm_generated').notNull(),
    /** The user-facing request the proposal was expanded from; holds no profile text. */
    intent: text('intent').notNull(),
    picks: jsonb('picks').$type<SurpriseProposalPicks>().notNull(),
    snapshot: jsonb('snapshot').$type<StyleSnapshot>().notNull(),
    title: text('title').notNull(),
    coverConcept: text('cover_concept'),
    preview: jsonb('preview').$type<SurpriseProposalPreview>().notNull(),
    /**
     * The Session this proposal was started as. Null is pending; set, the row
     * is no longer offered and exists only so a retried Start finds the Session
     * it already bought instead of buying another.
     */
    startedSessionId: uuid('started_session_id').references(() => activitySessions.id, {
      onDelete: 'cascade',
    }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('surprise_proposals_owner_unique').on(table.ownerUserId)],
);
