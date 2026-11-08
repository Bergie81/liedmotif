// The dimension math behind every image upload: how big a picked photo is
// decoded, how far the crop frame may zoom, and what size the confirmed crop is
// rendered at. Pure and browser-free, so the crop dialog, the render step, and
// the server's own framing all derive from the same rules.

import type { ImageUploadTarget } from './image-upload-targets';

export interface Size {
  width: number;
  height: number;
}

/** A crop rect in the working image's pixel space (what the dialog reports). */
export interface PixelRect extends Size {
  x: number;
  y: number;
}

/** Quarter turns; the dialog fixes sideways scans, it does not free-rotate. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * How much bigger than the stored rendition the working image is decoded. The
 * headroom IS the zoom range: the crop may tighten until it reaches the output
 * target, so oversampling by N allows N× zoom.
 */
const WORKING_OVERSAMPLE = 4;

/**
 * Ceiling on either working edge. Keeps the decoded bitmap far below the iOS
 * canvas-area limit (8192²) and its memory at a few tens of megabytes, whatever
 * the camera produced.
 */
const MAX_WORKING_EDGE = 3072;

/** Scale `source` down to fit inside `bound`, never up. */
export function fitWithin(source: Size, bound: Size): Size {
  const scale = Math.min(bound.width / source.width, bound.height / source.height, 1);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** The largest rect of `aspect` (width ÷ height) that fits inside `source`. */
export function largestAspectRect(source: Size, aspect: number): Size {
  return source.width / source.height > aspect
    ? { width: Math.max(1, Math.round(source.height * aspect)), height: source.height }
    : { width: source.width, height: Math.max(1, Math.round(source.width / aspect)) };
}

/** The bounding box a quarter-turn puts the image in. */
export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * The size a picked image is decoded at before it is shown or cropped. Big
 * enough that the tightest allowed crop still meets the output target, small
 * enough that a 48 MP phone photo never becomes a full-size bitmap.
 */
export function workingImageSize(source: Size, target: ImageUploadTarget): Size {
  return fitWithin(source, {
    width: Math.min(target.maxOutput.width * WORKING_OVERSAMPLE, MAX_WORKING_EDGE),
    height: Math.min(target.maxOutput.height * WORKING_OVERSAMPLE, MAX_WORKING_EDGE),
  });
}

/**
 * How far the crop frame may zoom in on a working image of this size: at the
 * maximum, the selected region is exactly the output target. Zooming past it
 * would only ask the server to upscale. 1 means the frame is pan-only — the
 * source has nothing to spare.
 */
export function maxCropZoom(working: Size, target: ImageUploadTarget): number {
  const frame = largestAspectRect(working, target.aspect);
  return Math.max(
    1,
    Math.min(frame.width / target.maxOutput.width, frame.height / target.maxOutput.height),
  );
}

/**
 * The size a confirmed crop is rendered at: the crop's own pixels, squared to
 * the target aspect and capped at the stored rendition — never upscaled, so a
 * small source yields a small (but honest) upload.
 */
export function cropOutputSize(crop: Size, target: ImageUploadTarget): Size {
  return fitWithin(largestAspectRect(crop, target.aspect), target.maxOutput);
}
