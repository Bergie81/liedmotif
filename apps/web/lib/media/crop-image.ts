// The browser half of an image upload: decode the picked file at a working
// size, hand the crop dialog something to show, and render the confirmed crop
// to the surface's output size. Only the rendered crop is ever uploaded, so a
// 48 MP camera file never crosses the network.
//
// Every step degrades to PASS-THROUGH — upload the original untouched — rather
// than failing: the server pipeline is the authority and already center-crops,
// strips metadata, and enforces the stored geometry on its own.

import {
  cropOutputSize,
  rotatedSize,
  workingImageSize,
  type PixelRect,
  type Rotation,
  type Size,
} from './crop-geometry';
import { MAX_IMAGE_UPLOAD_BYTES, type ImageUploadTarget } from './image-upload-targets';

/**
 * Quality for the transient upload blob. High on purpose: these bytes are the
 * last full-detail copy before the server's own re-encode, and they are
 * discarded straight after. JPEG because Safari cannot encode WebP from a
 * canvas — the container costs nothing here.
 */
const UPLOAD_ENCODE_QUALITY = 0.92;

/**
 * A source this big cannot be decoded safely without `createImageBitmap`'s
 * decode-at-size: the fallback would hand an oversized image to a canvas, which
 * WebKit answers with blank pixels and no error.
 */
const MAX_FALLBACK_DECODE_PIXELS = 16_700_000;

export interface CropSource {
  /** Object URL of the working-size image the dialog displays and measures. */
  url: string;
  /** Working-space pixels — the space a reported crop rect is expressed in. */
  size: Size;
  /** The drawable the confirmed crop is rendered from. */
  image: CanvasImageSource;
  /**
   * The working image is the picked file's own pixels, not a downscale — so a
   * crop that keeps all of them can upload the file itself and skip a lossy
   * generation the server would only re-encode again.
   */
  pristine: boolean;
  /** Drop the decoded bitmap and revoke the object URL. */
  release(): void;
}

export type PickedImage =
  | { kind: 'crop'; source: CropSource }
  /** Cropping is not possible here; the original file is uploaded as picked. */
  | { kind: 'pass-through' }
  /** Not an image this browser can read at all; nothing is worth uploading. */
  | { kind: 'undecodable' };

function canvasOfSize(size: Size): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable.');
  context.imageSmoothingQuality = 'high';
  return { canvas, context };
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', UPLOAD_ENCODE_QUALITY);
  });
}

/** Load the file into an `<img>`; resolves null when it is not a decodable image. */
function loadImageElement(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

interface DecodedImage {
  image: CanvasImageSource;
  size: Size;
  pristine: boolean;
  close(): void;
}

/**
 * Decode `file` at the working size for `target`. `createImageBitmap` resizes
 * WHILE decoding, so the full-size bitmap never exists; the `<img>` + canvas
 * fallback covers browsers without the resize options. Both honor the EXIF
 * orientation by default, so the working image is already upright.
 */
async function decodeWorkingImage(
  file: File,
  target: ImageUploadTarget,
): Promise<DecodedImage | 'undecodable' | 'pass-through'> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const element = await loadImageElement(sourceUrl);
    if (!element) return 'undecodable';
    const natural = { width: element.naturalWidth, height: element.naturalHeight };
    const size = workingImageSize(natural, target);
    const pristine = size.width === natural.width && size.height === natural.height;
    try {
      const bitmap = await createImageBitmap(file, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'high',
      });
      // Whatever came back IS the working space — never the requested size, so
      // a decoder that read the orientation differently cannot skew the crop.
      return {
        image: bitmap,
        size: { width: bitmap.width, height: bitmap.height },
        pristine,
        close: () => bitmap.close(),
      };
    } catch {
      if (natural.width * natural.height > MAX_FALLBACK_DECODE_PIXELS) return 'pass-through';
      const { canvas, context } = canvasOfSize(size);
      context.drawImage(element, 0, 0, size.width, size.height);
      return { image: canvas, size, pristine, close: () => undefined };
    }
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

/**
 * Prepare a picked file for cropping. The dialog is shown the working image
 * rather than the original, so what it measures and what the crop is rendered
 * from are the same pixels.
 */
export async function preparePickedImage(
  file: File,
  target: ImageUploadTarget,
): Promise<PickedImage> {
  /** Held only so a degrade below drops the bitmap a `crop` result hands over. */
  let unreleased: DecodedImage | null = null;
  try {
    const decoded = await decodeWorkingImage(file, target);
    if (typeof decoded === 'string') return { kind: decoded };
    unreleased = decoded;
    const { canvas, context } = canvasOfSize(decoded.size);
    context.drawImage(decoded.image, 0, 0, decoded.size.width, decoded.size.height);
    const preview = await toBlob(canvas);
    if (preview) {
      const url = URL.createObjectURL(preview);
      return {
        kind: 'crop',
        source: {
          url,
          size: decoded.size,
          image: decoded.image,
          pristine: decoded.pristine,
          release: () => {
            URL.revokeObjectURL(url);
            decoded.close();
          },
        },
      };
    }
  } catch {
    // Any failure past the decode degrades the same way as one during it.
  }
  unreleased?.close();
  return { kind: 'pass-through' };
}

/**
 * Whether the confirmed crop asks for nothing at all: no turn, and every pixel
 * of an already-untouched working image kept. The dialog reports integer
 * rects, so a rounded-off edge pixel still counts as the whole frame. A file
 * over the upload cap is never kept: the render is what brings it under.
 */
function keepsEverything(
  source: CropSource,
  original: File,
  crop: PixelRect,
  rotation: Rotation,
): boolean {
  return (
    source.pristine &&
    original.size <= MAX_IMAGE_UPLOAD_BYTES &&
    rotation === 0 &&
    crop.x <= 0 &&
    crop.y <= 0 &&
    crop.width >= source.size.width - 1 &&
    crop.height >= source.size.height - 1
  );
}

/**
 * Render the confirmed crop at the surface's output size. The rotation is
 * applied to the whole working image first — the crop rect the dialog reports
 * is measured against that rotated frame.
 *
 * A crop that changes nothing returns the picked file untouched: re-encoding it
 * would only spend a lossy generation on pixels the server re-encodes anyway.
 */
export async function renderCroppedFile({
  source,
  original,
  crop,
  rotation,
  target,
  filename,
}: {
  source: CropSource;
  original: File;
  crop: PixelRect;
  rotation: Rotation;
  target: ImageUploadTarget;
  filename: string;
}): Promise<File | null> {
  if (keepsEverything(source, original, crop, rotation)) return original;

  const framed = rotatedSize(source.size, rotation);
  const { canvas: stage, context: stageContext } = canvasOfSize(framed);
  stageContext.translate(framed.width / 2, framed.height / 2);
  stageContext.rotate((rotation * Math.PI) / 180);
  stageContext.translate(-source.size.width / 2, -source.size.height / 2);
  stageContext.drawImage(source.image, 0, 0);

  const output = cropOutputSize(crop, target);
  const { canvas, context } = canvasOfSize(output);
  context.drawImage(
    stage,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    output.width,
    output.height,
  );
  const blob = await toBlob(canvas);
  // An unsupported encode type silently yields PNG, so the blob's own type is
  // the only honest one to send.
  return blob ? new File([blob], filename, { type: blob.type }) : null;
}
