import {
  evaluateCoverImage,
  measureImageDimensions,
  normalizeCoverImageToWebp,
  type EvaluateCoverImage,
  type MeasureImage,
  type NormalizeCoverImage,
} from '@liedmotif/media';

export type CoverArtworkFinalizationFailure =
  'undecodable' | 'too_small' | 'not_square' | 'blank' | 'normalization_rejected';

export type FinalizedCoverArtwork =
  | {
      ok: true;
      bytes: Uint8Array;
      mediaType: 'image/webp';
    }
  | { ok: false; reason: CoverArtworkFinalizationFailure };

export interface CoverArtworkFinalizer {
  finish(input: { bytes: Uint8Array }): Promise<FinalizedCoverArtwork>;
}

export interface CoverArtworkFinalizerDeps {
  evaluate?: EvaluateCoverImage;
  /** Normalization pipeline seam (tests inject a stub). */
  normalize?: NormalizeCoverImage;
  /** Header-only dimension probe backing the post-normalization squareness check. */
  measure?: MeasureImage;
}

/**
 * Gate, normalize, and sanity-check provider artwork into the stored cover
 * rendition. Stored bytes are always clean — the Liedmotif badge exists only in
 * embedded album art, composited by the media package's album-art rendition.
 */
export function createCoverArtworkFinalizer(
  deps: CoverArtworkFinalizerDeps = {},
): CoverArtworkFinalizer {
  const evaluate = deps.evaluate ?? evaluateCoverImage;
  const normalize = deps.normalize ?? normalizeCoverImageToWebp;
  const measure = deps.measure ?? measureImageDimensions;

  return {
    async finish(input) {
      // The gate judges the provider's own bytes, so rejected artwork never
      // reaches the re-encode.
      const submitted = await evaluate(input.bytes).catch(() => ({
        ok: false as const,
        reason: 'undecodable' as const,
      }));
      if (!submitted.ok) return submitted;

      const normalized = await normalize(input.bytes).catch(() => null);
      if (!normalized) return { ok: false, reason: 'normalization_rejected' };

      // Header-only sanity check that the pipeline delivered the square it
      // promised — no pixel pass.
      const dimensions = await measure(normalized);
      if (!dimensions || dimensions.width !== dimensions.height) {
        return { ok: false, reason: 'normalization_rejected' };
      }

      return { ok: true, bytes: normalized, mediaType: 'image/webp' };
    },
  };
}
