// Tracks (the unit the user always sees) + their audio assets (the three-state
// ladder: provider stream, provider final, local original).
//
// CIRCULAR FK: `tracks.generationRequestId` and `tracks.providerJobId` close the
// activity_sessions -> tracks -> generation_requests cycle; broken with the
// `AnyPgColumn` lazy-`.references()` pattern. `coverImageId` -> `cover_images` is
// not circular but is annotated uniformly.
//
// NOTE on `providerKey`: this is the "which provider produced this" value, named
// `providerKey` to match `generation_requests`/`provider_jobs` and the
// `(providerKey, providerTrackId)` unique constraint.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
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
import { coverImages } from './covers';
import { generationRequests, providerJobs } from './generation';
import { analysisStatus, bpmSource, trackStatus, vocalMode, audioAssetType } from './enums';
import type { TimedLyrics } from '@liedmotif/shared';
import type { LicenseMetadata } from './types';

export const tracks = pgTable(
  'tracks',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    generationRequestId: uuid('generation_request_id')
      .notNull()
      .references((): AnyPgColumn => generationRequests.id, { onDelete: 'cascade' }),
    providerJobId: uuid('provider_job_id')
      .notNull()
      .references((): AnyPgColumn => providerJobs.id, { onDelete: 'cascade' }),
    // See file header: named for the unique index.
    providerKey: text('provider_key').notNull(),
    providerTrackId: text('provider_track_id').notNull(),
    // Title / artist are cosmetic and may be filled by a non-blocking metadata
    // step after the track row exists, so they are nullable.
    title: text('title'),
    generatedArtistName: text('generated_artist_name'),
    // The request's prompt IDENTITY (the Session's "same prompt" reroll/vibe
    // sense), not the exact per-track text submitted to the provider (that also
    // carries a hidden seed-picked variation and per-model length clamps).
    prompt: text('prompt').notNull(),
    promptFingerprint: text('prompt_fingerprint'),
    activity: text('activity'),
    mood: text('mood'),
    genreTags: jsonb('genre_tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    energy: text('energy'),
    // Per-track BPM estimate around the request's generation-time target BPM;
    // `bpmSource`/`analysisStatus` say whether it was MEASURED from the audio or
    // merely ANCHORED to the target (fake/anchored data never activates
    // beat-locking).
    bpmEstimate: doublePrecision('bpm_estimate'),
    // MEASURED per-track musical key — documented as a measured value, so the
    // analyzer no longer writes it (measured key is deferred to a future real key
    // analyzer; key policy uses the generation-time target key instead). Kept for
    // that future analyzer rather than overloaded.
    musicalKey: text('musical_key'),
    // --- Audio-analysis measurements + provenance.
    // All nullable: populated by the analysis job per its status. Both beat grids
    // are an anchor PLUS a locally fitted period (head and tail — a single global
    // BPM cannot bound tail phase error under drift).
    lufsIntegrated: doublePrecision('lufs_integrated'),
    truePeakDb: doublePrecision('true_peak_db'),
    headBeatAnchorSeconds: doublePrecision('head_beat_anchor_seconds'),
    headBeatPeriodSeconds: doublePrecision('head_beat_period_seconds'),
    tailBeatAnchorSeconds: doublePrecision('tail_beat_anchor_seconds'),
    tailBeatPeriodSeconds: doublePrecision('tail_beat_period_seconds'),
    analysisStatus: analysisStatus('analysis_status').notNull().default('pending'),
    // The analyzer version that produced these values; the queue route suppresses
    // stale versions and beat-locking requires equal versions on both decks.
    analysisVersion: integer('analysis_version'),
    analysisAttemptedAt: timestamp('analysis_attempted_at', { withTimezone: true }),
    bpmSource: bpmSource('bpm_source'),
    bpmConfidence: doublePrecision('bpm_confidence'),
    // Dislike-reroll intent: set when a Dislike
    // chose a FRESH-CALL reroll (no unplayed sibling), consumed by the buffer
    // controller's next generate — which then copies THIS track's request
    // identity + style prompt instead of compiling the live snapshot (so a
    // post-Change-Vibe reroll of an old-vibe track keeps the old vibe).
    rerollPendingAt: timestamp('reroll_pending_at', { withTimezone: true }),
    vocalMode: vocalMode('vocal_mode').notNull().default('instrumental'),
    // The provider-written sung lyric text (Liedmotif never authors
    // lyrics). Only VOCAL tracks ever store it; null on a vocal track means the
    // words have not been captured (yet). Enriched write-once, like duration.
    lyrics: text('lyrics'),
    // Word-level lyric timing, fetched lazily from the provider on first lyrics
    // view and cached forever (the call costs credits). Null = never fetched.
    timedLyrics: jsonb('timed_lyrics').$type<TimedLyrics>(),
    providerModel: text('provider_model'),
    generationParameters: jsonb('generation_parameters').$type<Record<string, unknown>>(),
    licenseMetadata: jsonb('license_metadata').$type<LicenseMetadata>(),
    rightsNote: text('rights_note'),
    coverImageId: uuid('cover_image_id').references((): AnyPgColumn => coverImages.id, {
      onDelete: 'set null',
    }),
    durationSeconds: integer('duration_seconds'),
    // The identity personal analytics knows this Track by. Random and
    // referenced by nothing, so a listening record that outlives the Track still
    // counts as one distinct Track without leading back to it.
    analyticsId: uuid('analytics_id').notNull().defaultRandom(),
    status: trackStatus('status').notNull().default('pending'),
    // User-state flags: `savedAt`/`favoritedAt` denormalize playlist membership
    // (`playlist_tracks`); `dislikedAt` is the source of truth for dislikes.
    savedAt: timestamp('saved_at', { withTimezone: true }),
    favoritedAt: timestamp('favorited_at', { withTimezone: true }),
    dislikedAt: timestamp('disliked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('tracks_created_at_idx').on(table.createdAt),
    index('tracks_status_idx').on(table.status),
    // Analysis-backlog sweep (every 5 min): ready tracks below the current
    // analysis version, oldest first.
    index('tracks_analysis_backlog_idx')
      .on(table.analysisVersion, table.createdAt)
      .where(sql`${table.status} = 'ready'`),
    // FK lookup paths that otherwise sequential-scan tracks: the worker's
    // due-poll sweep counts tracks per provider job, and reroll/materialization
    // plus the generation-request cascade resolve tracks by request.
    index('tracks_generation_request_id_idx').on(table.generationRequestId),
    index('tracks_provider_job_id_idx').on(table.providerJobId),
    // Library keyset pagination: owner-scoped, ordered by (sort column, id).
    // Owner is an equality filter, so one composite per sortable column serves
    // both scan directions.
    index('tracks_owner_saved_id_idx').on(table.ownerUserId, table.savedAt, table.id),
    index('tracks_owner_favorited_id_idx').on(table.ownerUserId, table.favoritedAt, table.id),
    index('tracks_owner_created_id_idx').on(table.ownerUserId, table.createdAt, table.id),
    // Cover reclamation resolves "is this cover still referenced?" by probing
    // each pointer table; partial because most tracks carry no custom cover.
    index('tracks_cover_image_id_idx')
      .on(table.coverImageId)
      .where(sql`${table.coverImageId} is not null`),
    // Search's Lyrics surface: one
    // `lyrics ilike '%q%'` per owned track, over the only column in the schema
    // that runs to kilobytes.
    index('tracks_lyrics_trgm_idx')
      .using('gin', sql`${table.lyrics} gin_trgm_ops`)
      .where(sql`${table.lyrics} is not null`),
    // Search's Playlist surface: its member-title probe is an `exists` subplan
    // whose inner `t.title ilike '%q%'` stands alone, so unlike the other
    // surfaces' multi-field OR it does get an index plan — the probe otherwise
    // reads every membership row of every owned playlist.
    index('tracks_title_trgm_idx')
      .using('gin', sql`${table.title} gin_trgm_ops`)
      .where(sql`${table.title} is not null`),
    // One row per provider track, when the provider id is known.
    uniqueIndex('tracks_provider_key_track_id_unique')
      .on(table.providerKey, table.providerTrackId)
      .where(sql`${table.providerTrackId} is not null`),
  ],
);

/**
 * Audio assets for a track. A track accrues assets as the cold-start ladder
 * advances; `isPlayable` marks which are servable. `encryptedSourceUrl` holds an
 * AES-GCM-encrypted provider URL used server-side only (never serialized to the
 * client); `storageKey` addresses downloaded local audio.
 */
export const trackAudioAssets = pgTable(
  'track_audio_assets',
  {
    id: pk(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    assetType: audioAssetType('asset_type').notNull(),
    storageProvider: text('storage_provider').notNull(),
    storageKey: text('storage_key'),
    encryptedSourceUrl: text('encrypted_source_url'),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    durationSeconds: integer('duration_seconds'),
    checksum: text('checksum'),
    isPlayable: boolean('is_playable').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    index('track_audio_assets_track_id_idx').on(table.trackId),
    // The deletion-queue drain asks "does any asset still reference this storage
    // key?" per queued item (batch 200, every minute) — without this index each
    // probe is a sequential scan of an ever-growing table.
    index('track_audio_assets_storage_key_idx')
      .on(table.storageKey)
      .where(sql`${table.storageKey} is not null`),
    // Diagnostics feed: newest locally stored finals.
    index('track_audio_assets_local_created_idx')
      .on(sql`${table.createdAt} desc`)
      .where(sql`${table.assetType} = 'local_original' and ${table.storageKey} is not null`),
    // Domain invariant: at most ONE asset of each kind per track (one provider
    // stream, one provider final, one local original). This is what makes the
    // worker's asset writes concurrency-idempotent (`onConflictDoNothing` on it) —
    // two overlapping polls/downloads can never double-insert the same asset type.
    uniqueIndex('track_audio_assets_track_id_asset_type_unique').on(table.trackId, table.assetType),
  ],
);
