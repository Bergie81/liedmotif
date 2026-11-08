import { describe, expect, it } from 'vitest';
import {
  cropOutputSize,
  fitWithin,
  largestAspectRect,
  maxCropZoom,
  rotatedSize,
  workingImageSize,
} from './crop-geometry';
import {
  AVATAR_UPLOAD,
  COVER_UPLOAD,
  REFERENCE_PHOTO_UPLOAD,
  type ImageUploadTarget,
} from './image-upload-targets';

/** A 48 MP phone photo — the case the whole client half exists for. */
const PHONE_PHOTO = { width: 8000, height: 6000 };

describe('fitWithin', () => {
  it('scales down to the tighter bound and keeps the aspect', () => {
    expect(fitWithin({ width: 4000, height: 3000 }, { width: 1000, height: 1000 })).toEqual({
      width: 1000,
      height: 750,
    });
  });

  it('never enlarges a source that already fits', () => {
    expect(fitWithin({ width: 300, height: 200 }, { width: 1000, height: 1000 })).toEqual({
      width: 300,
      height: 200,
    });
  });

  it('keeps a degenerate source at least one pixel', () => {
    expect(fitWithin({ width: 4000, height: 1 }, { width: 100, height: 100 })).toEqual({
      width: 100,
      height: 1,
    });
  });
});

describe('largestAspectRect', () => {
  it('takes the full height of a wider-than-target source', () => {
    expect(largestAspectRect({ width: 2000, height: 1000 }, 0.75)).toEqual({
      width: 750,
      height: 1000,
    });
  });

  it('takes the full width of a taller-than-target source', () => {
    expect(largestAspectRect({ width: 4000, height: 6000 }, 0.75)).toEqual({
      width: 4000,
      height: 5333,
    });
  });

  it('leaves a source that already matches the aspect untouched', () => {
    expect(largestAspectRect({ width: 1024, height: 1024 }, 1)).toEqual({
      width: 1024,
      height: 1024,
    });
  });
});

describe('rotatedSize', () => {
  it('swaps the edges on a quarter turn and keeps them on a half turn', () => {
    expect(rotatedSize({ width: 300, height: 200 }, 90)).toEqual({ width: 200, height: 300 });
    expect(rotatedSize({ width: 300, height: 200 }, 270)).toEqual({ width: 200, height: 300 });
    expect(rotatedSize({ width: 300, height: 200 }, 180)).toEqual({ width: 300, height: 200 });
    expect(rotatedSize({ width: 300, height: 200 }, 0)).toEqual({ width: 300, height: 200 });
  });
});

describe('workingImageSize', () => {
  it.each([
    ['avatar', AVATAR_UPLOAD],
    ['cover', COVER_UPLOAD],
    ['reference photo', REFERENCE_PHOTO_UPLOAD],
  ])('bounds a phone photo well under the canvas limit for the %s target', (_name, target) => {
    const working = workingImageSize(PHONE_PHOTO, target as ImageUploadTarget);
    expect(Math.max(working.width, working.height)).toBeLessThanOrEqual(3072);
    expect(working.width / working.height).toBeCloseTo(PHONE_PHOTO.width / PHONE_PHOTO.height, 2);
  });

  it('leaves a source smaller than the working bound untouched', () => {
    expect(workingImageSize({ width: 640, height: 480 }, AVATAR_UPLOAD)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('keeps enough pixels for the crop to reach the stored rendition', () => {
    for (const target of [AVATAR_UPLOAD, COVER_UPLOAD, REFERENCE_PHOTO_UPLOAD]) {
      const working = workingImageSize(PHONE_PHOTO, target);
      const frame = largestAspectRect(working, target.aspect);
      expect(frame.width).toBeGreaterThanOrEqual(target.maxOutput.width);
      expect(frame.height).toBeGreaterThanOrEqual(target.maxOutput.height);
    }
  });
});

describe('maxCropZoom', () => {
  it('allows zooming until the selected region is exactly the output target', () => {
    const zoom = maxCropZoom({ width: 2048, height: 2048 }, AVATAR_UPLOAD);
    expect(zoom).toBeCloseTo(4, 5);
    const tightest = cropOutputSize({ width: 2048 / zoom, height: 2048 / zoom }, AVATAR_UPLOAD);
    expect(tightest).toEqual(AVATAR_UPLOAD.maxOutput);
  });

  it('locks the frame to panning when the source cannot spare pixels', () => {
    expect(maxCropZoom({ width: 400, height: 400 }, COVER_UPLOAD)).toBe(1);
    expect(maxCropZoom({ width: 1024, height: 1024 }, COVER_UPLOAD)).toBe(1);
  });
});

describe('cropOutputSize', () => {
  it('caps a generous crop at the stored rendition', () => {
    expect(cropOutputSize({ width: 3000, height: 3000 }, COVER_UPLOAD)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(cropOutputSize({ width: 3000, height: 4000 }, REFERENCE_PHOTO_UPLOAD)).toEqual({
      width: 1536,
      height: 2048,
    });
  });

  it('never upscales a crop below the rendition', () => {
    expect(cropOutputSize({ width: 300, height: 400 }, REFERENCE_PHOTO_UPLOAD)).toEqual({
      width: 300,
      height: 400,
    });
  });

  it('squares an off-by-a-pixel crop onto the target aspect', () => {
    expect(cropOutputSize({ width: 601, height: 600 }, COVER_UPLOAD)).toEqual({
      width: 600,
      height: 600,
    });
  });
});
