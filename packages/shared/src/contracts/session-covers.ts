// Session Cover regeneration contracts:
// the regenerate / status / select endpoints the player's Regenerate Cover Art
// modal speaks. Registered in the endpoint registry in `endpoints.ts`; the
// multipart upload route is outside the JSON registry, like the avatar upload.

import { z } from 'zod';
import { apiResponse, isoDatetimeSchema, uuidSchema } from './common';
import { COVER_STYLE_CHOICES, COVER_STYLES, MAX_COVER_GUIDANCE_LENGTH } from './domain';

/**
 * Stable `cover_images.id` of the built-in placeholder cover. A LITERAL, not a
 * derivation: migration `0054_retire_stock_covers.sql` inserts this exact uuid.
 * It must never change — every existing session's `cover_image_id` points at
 * it. It lives here so the player can recognize the placeholder without the db
 * package.
 */
export const PLACEHOLDER_COVER_ID = '8740f2eb-48d1-57ca-bb0c-ad69b940810e';

/**
 * Hard cap on covers a Session may keep (its re-selectable history, current
 * cover included; uploads occupy a slot exactly like generated covers). At the
 * cap, rerolling and uploading both refuse until the user deletes a previous
 * cover — a storage/UX bound, separate from spend limits.
 */
export const MAX_SESSION_COVER_HISTORY = 10;

export const regenerateSessionCoverRequestSchema = z.strictObject({
  activitySessionId: uuidSchema,
  /** A changed style persists on the session; `random` resolves at request time. */
  coverStyle: z.enum(COVER_STYLE_CHOICES).optional(),
  /** Free-text art direction, frozen privately into the attempt's plan. */
  guidance: z.string().max(MAX_COVER_GUIDANCE_LENGTH).optional(),
  /** The People switch for THIS attempt: true uses the People named in the
   *  Session prompt or art direction, the owner when nobody is named; false
   *  sends no photos. Absent keeps the Session's own rules. */
  usePeopleReferences: z.boolean().optional(),
});
export type RegenerateSessionCoverRequest = z.infer<typeof regenerateSessionCoverRequestSchema>;

export const regenerateSessionCoverResponseSchema = apiResponse(
  z.strictObject({
    /** `started` reserved a new paid attempt; `pending` returned the live one. */
    outcome: z.enum(['started', 'pending']),
    coverGenerationId: uuidSchema,
  }),
);
export type RegenerateSessionCoverResponse = z.infer<typeof regenerateSessionCoverResponseSchema>;

/** The live-or-latest user regeneration attempt, as the modal renders it. */
export const sessionCoverAttemptSchema = z.strictObject({
  coverGenerationId: uuidSchema,
  /** The attempt's cover identity — a ready attempt previews it before the
   * user confirms the swap (regeneration never replaces the cover by itself). */
  coverImageId: uuidSchema,
  status: z.enum(['generating', 'ready', 'failed']),
  failureMessageSafe: z.string().nullable(),
});
export type SessionCoverAttempt = z.infer<typeof sessionCoverAttemptSchema>;

export const sessionCoverStatusRequestSchema = z.strictObject({
  activitySessionId: uuidSchema,
});
export type SessionCoverStatusRequest = z.infer<typeof sessionCoverStatusRequestSchema>;

/**
 * Advisory generated-cover budget for the modal's indicator — computed by the
 * same counting the worker enforces at admission, so the numbers cannot drift.
 */
export const sessionCoverUsageSchema = z.strictObject({
  usedDay: z.number().int().min(0),
  /** `null`: the window is unbounded (the Admin with the Cover ceiling off). */
  limitDay: z.number().int().min(0).nullable(),
  usedMonth: z.number().int().min(0),
  limitMonth: z.number().int().min(0).nullable(),
  /** Attempts left before the tighter window binds; 0 disables the button, `null` never does. */
  remaining: z.number().int().min(0).nullable(),
  /**
   * A One-time Member budget: the viewer has one total
   * rather than day/month windows, and the two window readouts both carry it.
   */
  oneTime: z.boolean(),
  /** Tailored (prompt-driven) cover art is switched on; regeneration needs it. */
  enabled: z.boolean(),
  providerConfigured: z.boolean(),
  /**
   * Covers currently come from the Suno source (no image provider configured,
   * or tailored cover art switched off). Regeneration stays unavailable — that
   * source yields one cover per music task — but the UI can explain WHY covers
   * still appear.
   */
  sunoFallbackActive: z.boolean(),
});
export type SessionCoverUsage = z.infer<typeof sessionCoverUsageSchema>;

/** One cover in the free re-select history: a settled attempt or an upload. */
export const sessionCoverHistoryEntrySchema = z.strictObject({
  coverImageId: uuidSchema,
  /** The resolved style lane the attempt was generated with, or `uploaded`. */
  style: z.string(),
  createdAt: isoDatetimeSchema,
  isCurrent: z.boolean(),
});
export type SessionCoverHistoryEntry = z.infer<typeof sessionCoverHistoryEntrySchema>;

export const sessionCoverStatusResponseSchema = apiResponse(
  z.strictObject({
    coverImageId: uuidSchema.nullable(),
    /** The session's persisted cover style — the Advanced fold's preselection. */
    coverStyle: z.enum(COVER_STYLES),
    /** Whether ANY generation attempt (initial or regeneration) is in flight. */
    generating: z.boolean(),
    latestRegeneration: sessionCoverAttemptSchema.nullable(),
    usage: sessionCoverUsageSchema,
    /** Settled generated covers and uploads, newest first (empty when none exist). */
    history: z.array(sessionCoverHistoryEntrySchema),
    /** Whether offering the People-reference switch makes sense: the owner has
     *  at least one Person with a reference photo and has not opted out. */
    peopleReferencesAvailable: z.boolean(),
  }),
);
export type SessionCoverStatusResponse = z.infer<typeof sessionCoverStatusResponseSchema>;

/**
 * The multipart upload's answer. The Session is NOT re-pointed: the upload
 * lands in the history as a candidate the owner previews and saves, the same
 * model a rerolled cover follows.
 */
export const uploadSessionCoverResponseSchema = apiResponse(
  z.strictObject({ coverImageId: uuidSchema }),
);
export type UploadSessionCoverResponse = z.infer<typeof uploadSessionCoverResponseSchema>;

export const selectSessionCoverRequestSchema = z.strictObject({
  activitySessionId: uuidSchema,
  coverImageId: uuidSchema,
});
export type SelectSessionCoverRequest = z.infer<typeof selectSessionCoverRequestSchema>;

export const selectSessionCoverResponseSchema = apiResponse(
  z.strictObject({ coverImageId: uuidSchema }),
);
export type SelectSessionCoverResponse = z.infer<typeof selectSessionCoverResponseSchema>;

export const deleteSessionCoverRequestSchema = z.strictObject({
  activitySessionId: uuidSchema,
  coverImageId: uuidSchema,
});
export type DeleteSessionCoverRequest = z.infer<typeof deleteSessionCoverRequestSchema>;

export const deleteSessionCoverResponseSchema = apiResponse(
  z.strictObject({ coverImageId: uuidSchema }),
);
export type DeleteSessionCoverResponse = z.infer<typeof deleteSessionCoverResponseSchema>;
