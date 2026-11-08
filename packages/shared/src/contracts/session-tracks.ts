import { z } from 'zod';
import { apiResponse, uuidSchema } from './common';

export const listSessionTracksRequestSchema = z.strictObject({
  sessionId: uuidSchema,
  cursor: z.string().max(512).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const sessionTrackItemSchema = z.strictObject({
  id: uuidSchema,
  title: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  styleRevision: z.number().int().positive().nullable(),
});

export const listSessionTracksResponseSchema = apiResponse(
  z.strictObject({
    items: z.array(sessionTrackItemSchema),
    total: z.number().int().nonnegative(),
    totalDurationSeconds: z.number().nonnegative(),
    genreTags: z.array(z.string()),
    nextCursor: z.string().nullable(),
  }),
);

export type SessionTracksData = Extract<
  z.infer<typeof listSessionTracksResponseSchema>,
  { ok: true }
>['data'];
