// Instance settings.
//
// `app_settings` is a typed key/value store. Global usage limits live
// here under the `usageLimits` key as one typed object — there is deliberately
// **no `usageLimits` table**. A Member's personal budget is the `limits` key in
// `user_settings`.

import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';
import type { UsageLimits } from './types';

/** Known `app_settings` keys. The value JSON shape depends on the key. */
export const APP_SETTINGS_KEYS = {
  /** The Admin's own usage limits (`UsageLimits`) — outside the Members Pool. */
  usageLimits: 'usageLimits',
  /** The shared ceiling over ALL Members (`MembersPool`). */
  memberPool: 'memberPool',
  /** The Admin's price per Track and per Cover (`UnitCosts`). */
  unitCosts: 'unitCosts',
  /** Instance configuration recorded at first run (`InstanceSettings`). */
  instance: 'instance',
  /** Generated-cover preferences, e.g. the saved Custom style (`CoverArtSettings`). */
  coverArt: 'coverArt',
  /**
   * The periodically measured stored-byte total (`StorageUsage`) the storage
   * quota is compared against — refreshed by the hourly sweep, never per request.
   */
  storageUsage: 'storageUsage',
  /**
   * The worker's liveness report (`WorkerHeartbeat`), upserted every heartbeat
   * interval (~10 s). Any future "settings changed" watcher must ignore this
   * key — its `updated_at` churns by design.
   */
  workerHeartbeat: 'workerHeartbeat',
  /** What Instance alerts last announced (`InstanceAlertsState`), per condition. */
  instanceAlerts: 'instanceAlerts',
  /**
   * `true` once NO pre-ledger legacy generated cover exists anymore. The set
   * only ever shrinks (every new generated cover is ledger-claimed), so once
   * empty the anti-join spend count is skipped forever.
   */
  legacyGeneratedCoversExhausted: 'legacyGeneratedCoversExhausted',
  /**
   * When the backup sidecar runs (`BackupSchedule`). The sidecar reads it
   * through `docker/backup-due.sql`, so the key and field names are part of
   * that query too.
   */
  backupSchedule: 'backupSchedule',
  /** The latest Back up now press (`BackupRequest`), read by the sidecar like `backupSchedule`. */
  backupRequest: 'backupRequest',
} as const;

export type AppSettingKey = (typeof APP_SETTINGS_KEYS)[keyof typeof APP_SETTINGS_KEYS];

/** 10 GiB, the default `storageQuotaBytes`. */
const TEN_GIB_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * The documented usage-limit defaults. `resetTimezone`
 * defaults to `INSTANCE_TIMEZONE` (falling back to `UTC`) at seed time; this
 * constant carries the static `UTC` baseline.
 */
export const DEFAULT_USAGE_LIMITS: UsageLimits = {
  // Both ceiling switches default on for a stored object without the key; a new
  // install's row is seeded with them off (`seedAppSettings`).
  trackCeilingEnabled: true,
  // Counted in provider calls, shown to the owner in Tracks (Suno yields 2 per
  // call): 50 Tracks a day and 250 a month.
  dailyGenerationTasks: 25,
  monthlyGenerationTasks: 125,
  resetTimezone: 'UTC',
  maxConcurrentJobs: 1,
  maxQueuedTracks: 6,
  maxSessionMinutesWithoutConfirmation: 60,
  maxRetriesPerJob: 2,
  storageQuotaBytes: TEN_GIB_BYTES,
  manualGenerationOnly: false,
  idleAutoStopAfterMinutes: 15,
  minHeadroomTracksToStartSession: 5,
  // Generated Session Cover art (cosmetic, image-provider spend — separate from
  // the music-model task caps above; counted in successful covers). Off, covers
  // still get generated: the music provider draws them from the music alone.
  tailoredCoverArtEnabled: true,
  coverCeilingEnabled: true,
  generatedCoversPerDay: 25,
  generatedCoversPerMonth: 100,
};

/**
 * Build the default usage limits, resolving `resetTimezone` from the explicit
 * argument, then `INSTANCE_TIMEZONE`, then `UTC`. Each candidate is trimmed and a
 * blank/whitespace-only value is treated as absent — `??` alone would let
 * `INSTANCE_TIMEZONE=''` seed an invalid empty timezone into the shipped defaults.
 */
export function defaultUsageLimits(resetTimezone?: string): UsageLimits {
  const timezone = resetTimezone?.trim() || process.env.INSTANCE_TIMEZONE?.trim() || 'UTC';
  return { ...DEFAULT_USAGE_LIMITS, resetTimezone: timezone };
}

/** Typed key/value instance settings (the `usageLimits` object lives here). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Known `user_settings` keys. The value JSON shape depends on the key. */
export const USER_SETTINGS_KEYS = {
  /** Owner-scoped playback settings (`PlaybackSettings` — blend on/off + crossfade). */
  playback: 'playback',
  /** Owner-scoped Buffer enablement and ready-ahead target (`GenerationSettings`). */
  generation: 'generation',
  /** Owner-scoped first-login onboarding completion (`OnboardingState`). */
  onboarding: 'onboarding',
  /** A Member's personal budget (`MemberLimits`) — written by the Admin. */
  limits: 'limits',
  /**
   * The owner's latest learned-taste answer. Derived: dropping the
   * row only costs one recomputation.
   */
  learnedTaste: 'learnedTaste',
  /**
   * The owner's latest Your stats answer. Derived like `learnedTaste`:
   * dropping the row only costs one recomputation.
   */
  listeningStats: 'listeningStats',
} as const;

export type UserSettingKey = (typeof USER_SETTINGS_KEYS)[keyof typeof USER_SETTINGS_KEYS];

/**
 * OWNER-SCOPED typed key/value settings —
 * `app_settings`' per-user counterpart, one set per Admin or Member. Values
 * are validated at the route boundary (`@liedmotif/shared` Zod schemas); the repo
 * stores only parsed objects.
 */
export const userSettings = pgTable(
  'user_settings',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('user_settings_owner_key_unique').on(table.ownerUserId, table.key)],
);
