// The per-surface contract for every image upload: the frame the crop dialog
// enforces, the largest rendition storage keeps, and the intake bounds. Client
// AND server read it — the picker crops to exactly what the route stores, so the
// two halves cannot drift. Keep it free of `sharp` and of provider imports: the
// crop UI is a client component.

/**
 * What every picker offers and every route accepts. The same trio the image
 * provider takes (`COVER_IMAGE_MEDIA_TYPES`), which matters for reference
 * photos — those bytes are forwarded to the model. Deliberately no HEIC: iOS
 * pickers hand over a JPEG transcode for a compatible allowlist.
 */
export const IMAGE_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export function isSupportedImageMimeType(type: string): boolean {
  return (IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * The same allowlist in the decoder's vocabulary — what the bytes must actually
 * BE, since the declared type above is only what the client called them. sharp
 * decodes HEIF, svg, tiff, gif and raw too, so nothing but this gate keeps a
 * mislabeled file out. The typed key set is what keeps the two halves one
 * allowlist: a new accepted type does not compile until it names its format.
 */
const DECODED_IMAGE_FORMATS: Record<(typeof IMAGE_UPLOAD_MIME_TYPES)[number], string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isSupportedImageFormat(format: string | null): boolean {
  return format !== null && Object.values(DECODED_IMAGE_FORMATS).includes(format);
}

/**
 * Byte cap on what is UPLOADED — the rendered crop, not the picked original. A
 * phone photo is many times this before the client downscales it.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Absurd-original guard the picker applies BEFORE decoding. Generous enough for
 * any real camera file, low enough that a hostile file never reaches a decoder.
 */
export const MAX_PICKED_IMAGE_BYTES = 80 * 1024 * 1024;

/** A byte cap as whole MB, the unit every message quoting one uses. */
export function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** What actually varies per surface: the frame, and what is stored from it. */
export interface ImageUploadTarget {
  /** Crop frame aspect, width ÷ height. */
  aspect: number;
  /** `round` masks the frame to the circle the avatar badge actually shows. */
  shape: 'round' | 'rect';
  /** The largest stored rendition; a crop is rendered at most this big, never upscaled. */
  maxOutput: { width: number; height: number };
}

/** Settings → Profile and the onboarding "You" step, shown as a circular chip. */
export const AVATAR_UPLOAD: ImageUploadTarget = {
  aspect: 1,
  shape: 'round',
  maxOutput: { width: 512, height: 512 },
};

/** Uploaded Session and Playlist covers — the generated-cover canvas. */
export const COVER_UPLOAD: ImageUploadTarget = {
  aspect: 1,
  shape: 'rect',
  maxOutput: { width: 1024, height: 1024 },
};

/**
 * Person reference photos. Portrait by mandate: the image model spends a fixed
 * attention budget per reference, so the frame belongs to the person.
 */
export const REFERENCE_PHOTO_UPLOAD: ImageUploadTarget = {
  aspect: 3 / 4,
  shape: 'rect',
  maxOutput: { width: 1536, height: 2048 },
};
