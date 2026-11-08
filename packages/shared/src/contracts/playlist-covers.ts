// Playlist custom-cover contracts (same path and full
// machinery as a Session Cover — admission lock, single attempt in flight,
// accumulating re-selectable history). The derived member-cover mosaic is the
// default and always the fallback: clearing the custom cover (select with a
// null coverImageId) returns to it. Registered in the endpoint registry in
// `endpoints.ts`; the multipart upload route is outside the JSON registry,
// like the avatar upload.

import { z } from 'zod';
import { apiResponse, uuidSchema } from './common';
import { COVER_STYLE_CHOICES, MAX_COVER_GUIDANCE_LENGTH } from './domain';
import {
  sessionCoverAttemptSchema,
  sessionCoverHistoryEntrySchema,
  sessionCoverUsageSchema,
} from './session-covers';

/** Hard cap on generated covers a Playlist may keep (mirrors the Session cap). */
export const MAX_PLAYLIST_COVER_HISTORY = 10;

/** The multipart upload's answer: the uploaded cover, already applied. */
export const uploadPlaylistCoverResponseSchema = apiResponse(
  z.strictObject({ coverImageId: uuidSchema }),
);
export type UploadPlaylistCoverResponse = z.infer<typeof uploadPlaylistCoverResponseSchema>;

export const regeneratePlaylistCoverRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  /** Per-attempt style lane; `random` resolves at request time. Unlike a
   *  Session, a Playlist persists no style — each attempt chooses its own. */
  coverStyle: z.enum(COVER_STYLE_CHOICES).optional(),
  /** Free-text art direction, frozen privately into the attempt's plan. */
  guidance: z.string().max(MAX_COVER_GUIDANCE_LENGTH).optional(),
  /** Per-generation LLM-enhancement override; absent → the global setting. */
  enhance: z.boolean().optional(),
  /** Carry the owner's People reference photos on THIS attempt.
   *  Off by default; nothing about it is persisted on the Playlist. */
  usePeopleReferences: z.boolean().optional(),
});
export type RegeneratePlaylistCoverRequest = z.infer<typeof regeneratePlaylistCoverRequestSchema>;

export const regeneratePlaylistCoverResponseSchema = apiResponse(
  z.strictObject({
    /** `started` reserved a new paid attempt; `pending` returned the live one. */
    outcome: z.enum(['started', 'pending']),
    coverGenerationId: uuidSchema,
  }),
);
export type RegeneratePlaylistCoverResponse = z.infer<typeof regeneratePlaylistCoverResponseSchema>;

export const playlistCoverStatusRequestSchema = z.strictObject({ playlistId: uuidSchema });
export type PlaylistCoverStatusRequest = z.infer<typeof playlistCoverStatusRequestSchema>;

export const playlistCoverStatusResponseSchema = apiResponse(
  z.strictObject({
    /** The playlist's CUSTOM cover; null = the derived mosaic renders. */
    coverImageId: uuidSchema.nullable(),
    /** Whether a generation attempt is in flight. */
    generating: z.boolean(),
    latestRegeneration: sessionCoverAttemptSchema.nullable(),
    usage: sessionCoverUsageSchema,
    /** Settled generated covers, newest first (uploaded covers included). */
    history: z.array(sessionCoverHistoryEntrySchema),
    /** Whether offering the People-reference toggle makes sense: the owner has
     *  at least one Person with a reference photo and has not opted out. */
    peopleReferencesAvailable: z.boolean(),
    promptEnhancement: z.strictObject({
      llmConfigured: z.boolean(),
      active: z.boolean(),
    }),
  }),
);
export type PlaylistCoverStatusResponse = z.infer<typeof playlistCoverStatusResponseSchema>;

export const selectPlaylistCoverRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  /** A history/attempt cover to adopt, or null to clear back to the mosaic. */
  coverImageId: uuidSchema.nullable(),
});
export type SelectPlaylistCoverRequest = z.infer<typeof selectPlaylistCoverRequestSchema>;

export const selectPlaylistCoverResponseSchema = apiResponse(
  z.strictObject({ coverImageId: uuidSchema.nullable() }),
);
export type SelectPlaylistCoverResponse = z.infer<typeof selectPlaylistCoverResponseSchema>;

export const deletePlaylistCoverRequestSchema = z.strictObject({
  playlistId: uuidSchema,
  coverImageId: uuidSchema,
});
export type DeletePlaylistCoverRequest = z.infer<typeof deletePlaylistCoverRequestSchema>;

export const deletePlaylistCoverResponseSchema = apiResponse(
  z.strictObject({ coverImageId: uuidSchema }),
);
export type DeletePlaylistCoverResponse = z.infer<typeof deletePlaylistCoverResponseSchema>;
