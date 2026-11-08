// Quality gate for generated Session Cover bytes (UX doc "Quality gate"): a paid
// image only replaces the session's placeholder cover when it decodes, is
// (near-)square, meets minimum dimensions, and is not obviously blank. Kept
// behind a narrow function type so the cover job is testable without sharp
// (tests inject a stub) — same pattern as `renderAlbumArt`.
//
// Deliberately NOT checked: readable text / logo detection ("where detectable"
// in the doc) — that needs a vision model, not a deterministic gate.

import { openImage } from './image-decode';

/** Reject covers whose short edge is below this (the models emit 1K+). */
const MIN_COVER_EDGE = 512;
/** "Square or safely croppable to square": long/short edge at most this. */
const MAX_ASPECT_RATIO = 1.25;
/** A solid/blank frame has (near-)zero variance in every channel. */
const MIN_CHANNEL_STDDEV = 2;

/** Every finalized cover is normalized to this square edge before storage. */
export const NORMALIZED_COVER_EDGE = 1024;
/** WebP quality for finalized cover encodes. */
export const COVER_WEBP_QUALITY = 90;
/** Thumbnail quality: list/grid tiles render at 42–64 CSS px, so artifacts are
 *  invisible and the byte win over the 1024² original is what matters. */
const THUMBNAIL_WEBP_QUALITY = 80;

export type CoverQualityVerdict =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: 'undecodable' | 'too_small' | 'not_square' | 'blank' };

export type EvaluateCoverImage = (bytes: Uint8Array) => Promise<CoverQualityVerdict>;
export type NormalizeCoverImage = (bytes: Uint8Array) => Promise<Uint8Array>;
export type MeasureImage = (bytes: Uint8Array) => Promise<{ width: number; height: number } | null>;

/** Header-only dimensions — no pixel pass; null when the bytes don't decode. */
export const measureImageDimensions: MeasureImage = async (bytes) => {
  try {
    const { width, height } = await openImage(bytes).metadata();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
};

export const normalizeCoverImageToWebp: NormalizeCoverImage = async (bytes) => {
  const normalized = await openImage(bytes)
    .rotate()
    .resize(NORMALIZED_COVER_EDGE, NORMALIZED_COVER_EDGE, { fit: 'cover', position: 'centre' })
    .webp({ quality: COVER_WEBP_QUALITY })
    .toBuffer();
  return new Uint8Array(normalized);
};

/**
 * Downscale a stored cover to a square thumbnail edge for list/grid tiles —
 * covers are normalized square at ingest, so this is a pure size reduction
 * (~150 KB originals become a few KB for 48-px tiles).
 */
export async function renderCoverThumbnail(bytes: Uint8Array, edge: number): Promise<Uint8Array> {
  const thumb = await openImage(bytes)
    .resize(edge, edge, { fit: 'cover', position: 'centre' })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer();
  return new Uint8Array(thumb);
}

export const evaluateCoverImage: EvaluateCoverImage = async (bytes) => {
  try {
    const image = openImage(bytes);
    const { width, height } = await image.metadata();
    if (!width || !height) return { ok: false, reason: 'undecodable' };
    if (Math.min(width, height) < MIN_COVER_EDGE) return { ok: false, reason: 'too_small' };
    if (Math.max(width, height) / Math.min(width, height) > MAX_ASPECT_RATIO) {
      return { ok: false, reason: 'not_square' };
    }
    const stats = await image.stats();
    if (stats.channels.every((channel) => channel.stdev < MIN_CHANNEL_STDDEV)) {
      return { ok: false, reason: 'blank' };
    }
    return { ok: true, width, height };
  } catch {
    return { ok: false, reason: 'undecodable' };
  }
};
