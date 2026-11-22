// The naming answer a text LLM returns, read leniently: a pick or field in an
// unexpected shape is no pick rather than a failed reply.

import { COVER_STYLE_PRESETS, narrowTo, type CoverStylePreset } from '@liedmotif/shared';
import { z } from 'zod';
import { clampCoverConcept, type SessionNamingMetadata } from './session-title';
import { clampActivity, clampLyricContext, clampTrackTitles } from './snapshot';

/** A pick spelled with other case or separators ("Record Sleeve", "poster-art")
 *  read as the preset it spells, or null. */
function looseCoverStylePick(value: unknown): CoverStylePreset | null {
  if (typeof value !== 'string') return null;
  return narrowTo(
    COVER_STYLE_PRESETS,
    value
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
}

/** The Auto cover pick (ADR 0007): one of the six presets, and anything else,
 *  missing included, is no pick rather than a failed reply. The schema sent to
 *  the model stays the plain enum; the fallback reads only the spelling. */
export const coverStylePickSchema = z
  .enum(COVER_STYLE_PRESETS)
  .nullable()
  .catch((ctx) => looseCoverStylePick(ctx?.input));

/** The creative-naming response shape (`createSessionMetadata`); all default so
 *  a partial reply still validates and consumers keep their deterministic fallback. */
export const sessionNamingSchema = z.object({
  title: z.string().default(''),
  trackTitles: z.array(z.string()).default([]),
  lyricContext: z.string().default(''),
  coverConcept: z.string().default(''),
  coverStyle: coverStylePickSchema,
});

/** The naming answer for a More Like This context: two more fields, the activity
 *  and whether the listener is in the scene, which an invalid answer leaves empty
 *  and false rather than failing the reply. */
export const contextNamingSchema = sessionNamingSchema.extend({
  activity: z.string().catch(''),
  includesListener: z.boolean().catch(false),
});

/** A usable naming proposal from a model value, or null. The title is required —
 *  without a name the reply is useless even if it carried a track-title pool. The
 *  pool and lyric context are clamped here (the write boundary: they merge straight
 *  into the stored snapshot, no schema parse in between). */
export function normalizeSessionNaming(value: unknown): SessionNamingMetadata | null {
  const result = sessionNamingSchema.safeParse(value);
  if (!result.success || !result.data.title.trim()) return null;
  return {
    title: result.data.title.trim(),
    trackTitles: clampTrackTitles(result.data.trackTitles),
    lyricContext: clampLyricContext(result.data.lyricContext),
    coverConcept: clampCoverConcept(result.data.coverConcept),
    autoCoverStyle: result.data.coverStyle,
  };
}

/** A context's naming is the feature, so it is usable only with a Name AND a pool. */
export function normalizeContextNaming(value: unknown): SessionNamingMetadata | null {
  const naming = normalizeSessionNaming(value);
  if (!naming || naming.trackTitles.length === 0) return null;
  // The shared fields validated above and the two context fields never fail.
  const { activity, includesListener } = contextNamingSchema.parse(value);
  return { ...naming, activity: clampActivity(activity), includesListener };
}
