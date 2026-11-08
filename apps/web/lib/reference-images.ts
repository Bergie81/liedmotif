// Server-side processing for uploaded Person reference photos. The RAW upload is
// never stored: the image is re-encoded through sharp, which applies the EXIF
// orientation and then drops ALL metadata (EXIF/GPS/ICC) — a privacy requirement
// for personal photos — and is framed to the portrait crop the image model reads.

import { openImage } from '@liedmotif/media';
import { cropOutputSize } from './crop-geometry';
import { withUploadDecodeSlot } from './image-decode-slots';
import { REFERENCE_PHOTO_UPLOAD } from './image-upload-targets';

export interface ProcessedReferenceImage {
  bytes: Uint8Array;
  mediaType: 'image/webp';
  width: number | null;
  height: number | null;
}

/**
 * Re-encode an upload as a portrait, metadata-free WebP. Returns null when the
 * bytes are not a decodable image, or exceed the decode ceiling (the route maps
 * either to a validation error).
 */
export async function processCoverReferenceUpload(
  input: Uint8Array,
): Promise<ProcessedReferenceImage | null> {
  try {
    return await withUploadDecodeSlot(async () => {
      // `.rotate()` bakes the EXIF orientation into the pixels; all metadata is
      // dropped by the re-encode (sharp strips it unless `withMetadata()` is
      // called). `metadata().width/height` stay as STORED, so the framing below
      // reads `autoOrient` — the dimensions the owner actually sees.
      const upright = openImage(input).rotate();
      const { autoOrient } = await upright.metadata();
      if (!autoOrient?.width || !autoOrient.height) return null;
      // The same framing the crop dialog applies, so a pass-through upload of any
      // other aspect is center-cropped rather than letter-boxed — the image model
      // spends a fixed attention budget per reference, and background is waste.
      const rendition = cropOutputSize(autoOrient, REFERENCE_PHOTO_UPLOAD);
      const { data, info } = await upright
        .resize(rendition.width, rendition.height, { fit: 'cover', position: 'centre' })
        // Identity detail is the payload here, and it is unrecoverable once
        // stored — the originals are deliberately never kept.
        .webp({ quality: 90, smartSubsample: true })
        .toBuffer({ resolveWithObject: true });
      return {
        bytes: new Uint8Array(data),
        mediaType: 'image/webp' as const,
        width: info.width ?? null,
        height: info.height ?? null,
      };
    });
  } catch {
    return null;
  }
}
