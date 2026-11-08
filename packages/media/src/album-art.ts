// Album-art rendition for ID3 embedding. `APIC` frames should carry JPEG/PNG
// for broad player compatibility, but Liedmotif covers may be WebP (generated
// and placeholder covers) or SVG — those are converted to a bounded JPEG via
// sharp. This is also the ONE place the Liedmotif brand badge is composited:
// stored Cover bytes are clean, and only files that leave the app (embedded
// album art) carry the badge. A cover whose stored bytes already carry it — a
// legacy row or the built-in placeholder — embeds as-is, never double-badged.
// Kept behind a narrow function type so the callers (the worker's retag job,
// the web download composition) are testable without sharp — tests inject a
// stub.
//
// Byte-in/byte-out like the rest of this package: the caller supplies the cover
// bytes through `AlbumArtSource.readCover`, so nothing here knows about storage.

import sharp from 'sharp';
import type { Id3Artwork } from '@liedmotif/shared';
import { rasterizedBrandOverlay } from './cover-branding';
import { NORMALIZED_COVER_EDGE } from './cover-quality';
import { openImage } from './image-decode';

export type RenderAlbumArt = (
  bytes: Uint8Array,
  mediaType: string | null,
  /** Whether the stored bytes already carry the brand badge. */
  branded: boolean,
) => Promise<Id3Artwork | null>;

const ALBUM_ART_MAX_EDGE = 1024;

/**
 * For an already-branded cover: JPEG/PNG pass through untouched; anything else
 * is re-encoded as a JPEG capped at 1024px. A cover still needing the badge is
 * always decoded, composited, and re-encoded — the pass-through never applies.
 * Returns null when the bytes cannot be decoded or the composite fails — the
 * caller embeds text frames without artwork (best-effort, never a failure), and
 * a failed composite is a failed rendition, never a fallback to unbadged art.
 */
export const renderAlbumArt: RenderAlbumArt = async (bytes, mediaType, branded) => {
  if (branded) {
    if (mediaType === 'image/jpeg' || mediaType === 'image/png') {
      return { mediaType, bytes };
    }
    try {
      const rendered = await openImage(bytes)
        .resize(ALBUM_ART_MAX_EDGE, ALBUM_ART_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
      return { mediaType: 'image/jpeg', bytes: new Uint8Array(rendered) };
    } catch {
      return null;
    }
  }
  try {
    // The overlay is authored at the normalized cover edge and stored covers
    // match it, but the composite is sized to the ACTUAL decoded image (capped,
    // never enlarged) so an off-size cover still badges instead of throwing.
    const { width, height } = await openImage(bytes).metadata();
    if (!width || !height) return null;
    const scale = Math.min(1, ALBUM_ART_MAX_EDGE / Math.max(width, height));
    const edge = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    const overlay = await badgeOverlaySized(edge.width, edge.height);
    const rendered = await openImage(bytes)
      .resize(edge.width, edge.height, { fit: 'fill' })
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();
    return { mediaType: 'image/jpeg', bytes: new Uint8Array(rendered) };
  } catch {
    return null;
  }
};

/** The rasterized badge at the rendition's output size (cached at the authored edge). */
async function badgeOverlaySized(width: number, height: number): Promise<Buffer> {
  const overlay = await rasterizedBrandOverlay();
  if (width === NORMALIZED_COVER_EDGE && height === NORMALIZED_COVER_EDGE) return overlay;
  return sharp(overlay).resize(width, height, { fit: 'fill' }).png().toBuffer();
}

/**
 * Tiny LRU of rendered album art keyed by cover image id. Without it a
 * session-wide retag (or a session zip download) re-renders the SAME cover for
 * every track — byte-identical output every time, since cover images are
 * immutable and a new upload/generation mints a new id. Small on purpose:
 * entries are ≤ ~300 KB JPEGs and one batch or request touches few distinct
 * covers.
 */
export class AlbumArtCache {
  private readonly entries = new Map<string, Id3Artwork>();

  constructor(private readonly capacity = 8) {}

  get(coverImageId: string): Id3Artwork | null {
    const hit = this.entries.get(coverImageId);
    if (!hit) return null;
    // Refresh recency: Map iteration order is insertion order.
    this.entries.delete(coverImageId);
    this.entries.set(coverImageId, hit);
    return hit;
  }

  set(coverImageId: string, artwork: Id3Artwork): void {
    this.entries.delete(coverImageId);
    this.entries.set(coverImageId, artwork);
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}

export interface AlbumArtSource {
  /** The stored cover object in full, with the media type its key implies. */
  readCover: (storageKey: string) => Promise<{ bytes: Uint8Array; mediaType: string | null }>;
  renderAlbumArt: RenderAlbumArt;
  /** Memo across one retag batch or one download request. */
  artworkCache?: AlbumArtCache;
}

/**
 * The `APIC` rendition of a Session's effective Cover, or null when its bytes
 * cannot be read or decoded. Artwork is best-effort everywhere it is used, so
 * this never throws — a caller decides for itself whether to write text-only
 * tags or leave a file alone.
 */
export async function loadAlbumArt(
  source: AlbumArtSource,
  cover: { coverImageId: string; storageKey: string; branded: boolean },
): Promise<Id3Artwork | null> {
  const cached = source.artworkCache?.get(cover.coverImageId);
  if (cached) return cached;
  const artwork = await source
    .readCover(cover.storageKey)
    .then(({ bytes, mediaType }) => source.renderAlbumArt(bytes, mediaType, cover.branded))
    .catch(() => null);
  if (artwork) source.artworkCache?.set(cover.coverImageId, artwork);
  return artwork;
}
