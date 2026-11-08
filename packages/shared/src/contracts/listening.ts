// Personal listening analytics: the progress report every playback
// surface sends, and the owner's stats read.
//
// The report names a Track and says how long it has been heard — nothing else.
// Ownership and every musical attribute are derived server-side, so the strict
// object refuses a client that tries to supply them.

import { z } from 'zod';
import { apiResponse, isoDatetimeSchema, uuidSchema } from './common';

/**
 * Where the Track was heard. A surface is provenance, never eligibility: only
 * listener-owns-Track decides whether a report counts, so an own Track heard
 * through a Lounge-visible Playlist is a `playlist` listen like any other.
 */
export const LISTENING_SURFACES = ['session', 'playlist', 'preview'] as const;
export type ListeningSurface = (typeof LISTENING_SURFACES)[number];
export const LISTENING_RANGES = ['7d', '30d', 'all'] as const;
export type ListeningRange = (typeof LISTENING_RANGES)[number];
export const DEFAULT_LISTENING_RANGE: ListeningRange = '30d';
/** Calendar days, ending today, that each bounded range covers. */
export const LISTENING_RANGE_DAYS: Record<Exclude<ListeningRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
};
/** How many calendar days, ending today, the per-day listening series may reach back. */
export const DAILY_LISTENING_LIMIT = 90;

/**
 * Why an occurrence closed: the Track played out (`ended`), the listener moved
 * off it (`navigated`), its audio died (`failed`), another start took its place
 * with no ending of its own (`replaced`), or the surface went away (`stopped`).
 */
export const LISTENING_END_REASONS = [
  'ended',
  'navigated',
  'failed',
  'replaced',
  'stopped',
] as const;
export type ListeningEndReason = (typeof LISTENING_END_REASONS)[number];

/**
 * What started the occurrence: a deliberate act (`user`), the Queue moving on
 * by itself (`auto`), or the same Track coming round again unprompted (`loop`).
 */
export const LISTENING_ORIGINS = ['user', 'auto', 'loop'] as const;
export type ListeningOrigin = (typeof LISTENING_ORIGINS)[number];

export const reportListeningRequestSchema = z.strictObject({
  /** Minted once per playback occurrence; every progress report for it reuses the value. */
  occurrenceId: uuidSchema,
  trackId: uuidSchema,
  /** The Session whose Queue is playing; null on every other surface. */
  sessionId: uuidSchema.nullable(),
  surface: z.enum(LISTENING_SURFACES),
  startedAt: isoDatetimeSchema,
  origin: z.enum(LISTENING_ORIGINS),
  /**
   * Cumulative credited listening for the occurrence. Time two Tracks shared in
   * a crossfade is divided between them, so one player's credits sum to its
   * elapsed listening.
   */
  listenedMs: z.number().int().nonnegative(),
  /** Cumulative time this Track itself was audibly playing, overlap undivided; decides the play. */
  playedMs: z.number().int().nonnegative(),
  clientTimestamp: isoDatetimeSchema,
  endReason: z.enum(LISTENING_END_REASONS).nullable(),
});
export type ReportListeningRequest = z.infer<typeof reportListeningRequestSchema>;

export const reportListeningResponseSchema = apiResponse(
  z.strictObject({ accepted: z.literal(true) }),
);

export const listeningStatsQuerySchema = z.strictObject({
  range: z.enum(LISTENING_RANGES).default(DEFAULT_LISTENING_RANGE),
});

const trackCount = z.number().int().nonnegative();

/**
 * What the music model produced for the owner in the range. Every quantity is
 * in Tracks except `failedAttempts`: a failed attempt is one music-model call,
 * and says nothing about how many Tracks it would have yielded.
 */
export const generationStatsSchema = z.strictObject({
  /** Tracks that first became playable in the range, deleted ones included. */
  generatedTracks: trackCount,
  /** Of those, surviving Tracks from before output was recorded — an incomplete count of their era. */
  historicalTracks: trackCount,
  /** Generated Tracks whose final audio could not be stored; never a generation failure. */
  storageFailures: trackCount,
  failedAttempts: z.number().int().nonnegative(),
  /** Generated since listening was recorded, and never listened to. */
  neverHeardTracks: trackCount,
  /** Generated before listening was recorded: heard or not is unknown. */
  unknownCoverageTracks: trackCount,
});
export type GenerationStatsData = z.infer<typeof generationStatsSchema>;

export const listeningStatsSchema = z.strictObject({
  range: z.enum(LISTENING_RANGES),
  timezone: z.string().min(1),
  /** Start of the range; null for all time. */
  from: isoDatetimeSchema.nullable(),
  listenedMs: z.number().int().nonnegative(),
  qualifyingPlays: z.number().int().nonnegative(),
  /** Distinct Tracks heard in the range, deleted ones included. */
  uniqueTracks: z.number().int().nonnegative(),
  /**
   * Most-played by qualifying plays. A deleted Track keeps its plays and carries
   * neither id nor title; the identity analytics counts it by never leaves the server.
   */
  topTracks: z.array(
    z.strictObject({
      trackId: uuidSchema.nullable(),
      title: z.string().nullable(),
      coverImageId: uuidSchema.nullable(),
      originSessionId: uuidSchema.nullable(),
      plays: z.number().int().positive(),
    }),
  ),
  /** Most listened by credited time, split equally across a Track's genres; null is untagged time. */
  topGenres: z.array(
    z.strictObject({
      genre: z.string().nullable(),
      listenedMs: z.number().int().nonnegative(),
    }),
  ),
  /**
   * Credited time per calendar day of `timezone`, oldest first. Days without
   * listening are absent, and all time reaches back a bounded number of days.
   */
  daily: z.array(
    z.strictObject({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      listenedMs: z.number().int().positive(),
    }),
  ),
  collectionStartedAt: isoDatetimeSchema,
  /** The range opens before collection did: its early part is unknown, not silent. */
  rangePredatesCollection: z.boolean(),
  generation: generationStatsSchema,
});
export type ListeningStatsData = z.infer<typeof listeningStatsSchema>;
export const listeningStatsResponseSchema = apiResponse(listeningStatsSchema);

export const clearListeningHistoryRequestSchema = z.strictObject({});
export const clearListeningHistoryResponseSchema = apiResponse(
  z.strictObject({ cleared: z.literal(true) }),
);

/** Personalize suggestions: whether learned taste is gathered and used. Stats never depend on it. */
export const setPersonalizationRequestSchema = z.strictObject({ enabled: z.boolean() });
export const setPersonalizationResponseSchema = apiResponse(
  z.strictObject({ enabled: z.boolean() }),
);

export const resetLearnedTasteRequestSchema = z.strictObject({});
export const resetLearnedTasteResponseSchema = apiResponse(
  z.strictObject({ reset: z.literal(true) }),
);
