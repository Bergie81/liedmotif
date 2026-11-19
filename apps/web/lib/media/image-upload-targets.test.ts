import { describe, expect, it } from 'vitest';
import { NORMALIZED_COVER_EDGE } from '@liedmotif/media';
import { COVER_IMAGE_MEDIA_TYPES } from '@liedmotif/providers';
import { AVATAR_EDGE } from './avatar-image';
import {
  AVATAR_UPLOAD,
  COVER_UPLOAD,
  IMAGE_UPLOAD_MIME_TYPES,
  REFERENCE_PHOTO_UPLOAD,
} from './image-upload-targets';

describe('image upload targets', () => {
  // Reference photos are forwarded to the image model verbatim, so an allowlist
  // the provider does not accept would only fail later, at generation time.
  it('offers exactly the media types the image provider accepts', () => {
    expect([...IMAGE_UPLOAD_MIME_TYPES]).toEqual([...COVER_IMAGE_MEDIA_TYPES]);
  });

  // The picker crops to exactly what the route stores. Avatar and reference
  // renditions are derived from these targets in code; a cover's is not — the
  // normalization it shares with generated covers owns that number.
  it('crops covers to the size the cover pipeline normalizes to', () => {
    expect(COVER_UPLOAD.maxOutput).toEqual({
      width: NORMALIZED_COVER_EDGE,
      height: NORMALIZED_COVER_EDGE,
    });
    expect(AVATAR_UPLOAD.maxOutput.width).toBe(AVATAR_EDGE);
  });

  it('states a portrait frame for reference photos and a square one elsewhere', () => {
    expect(AVATAR_UPLOAD.aspect).toBe(1);
    expect(COVER_UPLOAD.aspect).toBe(1);
    expect(REFERENCE_PHOTO_UPLOAD.aspect).toBeLessThan(1);
    for (const target of [AVATAR_UPLOAD, COVER_UPLOAD, REFERENCE_PHOTO_UPLOAD]) {
      expect(target.maxOutput.width / target.maxOutput.height).toBeCloseTo(target.aspect, 5);
    }
  });
});
