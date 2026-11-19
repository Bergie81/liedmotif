// Server-side processing for the uploaded profile avatar. The RAW upload is
// never stored: sharp bakes in the EXIF orientation, center-crops to a square,
// and re-encodes to WebP — which drops ALL metadata (EXIF/GPS/ICC), a privacy
// requirement for personal photos. The avatar is a UI identity chip only and
// must never feed cover generation (that pipeline reads Person reference
// photos exclusively).

import { openImage } from '@liedmotif/media';
import { withUploadDecodeSlot } from './image-decode-slots';
import { AVATAR_UPLOAD } from './image-upload-targets';

/** Uniform square edge for the stored avatar — crisp at chip size on any display. */
export const AVATAR_EDGE = AVATAR_UPLOAD.maxOutput.width;

export interface ProcessedAvatarImage {
  bytes: Uint8Array;
  mediaType: 'image/webp';
}

/**
 * Re-encode an upload as a square, metadata-free WebP avatar. Returns null when
 * the bytes are not a decodable image or exceed the decode ceiling (the route
 * maps either to a validation error). The center crop is the safety net for an
 * upload that skipped the crop dialog.
 */
export async function processAvatarUpload(input: Uint8Array): Promise<ProcessedAvatarImage | null> {
  try {
    const bytes = await withUploadDecodeSlot(() =>
      openImage(input)
        .rotate()
        .resize(AVATAR_EDGE, AVATAR_EDGE, { fit: 'cover' })
        .webp({ quality: 85 })
        .toBuffer(),
    );
    return { bytes: new Uint8Array(bytes), mediaType: 'image/webp' };
  } catch {
    return null;
  }
}
