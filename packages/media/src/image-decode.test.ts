import sharp, { type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectImageFormat, MAX_DECODE_PIXELS, openImage } from './image-decode';

/** A solid-color JPEG at arbitrary dimensions — kilobytes on disk at any size. */
async function jpegOf(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 80, b: 200 } },
      limitInputPixels: false,
    })
      .jpeg({ quality: 50 })
      .toBuffer(),
  );
}

describe('openImage decode ceiling', () => {
  it('decodes a full-resolution 200 MP phone photo', async () => {
    // 16320×12240 is what current 200 MP phone sensors actually emit — the
    // frame the ceiling is sized to admit.
    const photo = await jpegOf(16320, 12240);
    const thumb = await openImage(photo).resize(64, 64, { fit: 'cover' }).webp().toBuffer();
    expect(thumb.length).toBeGreaterThan(0);
  });

  it('refuses a source above the ceiling before decoding it', async () => {
    const width = 16000;
    const height = 15000;
    expect(width * height).toBeGreaterThan(MAX_DECODE_PIXELS);
    const bomb = await jpegOf(width, height);
    await expect(openImage(bomb).toBuffer()).rejects.toThrow(/pixel limit/);
  });
});

describe('detectImageFormat', () => {
  /** A 4×4 frame encoded as whatever format sharp is asked for. */
  async function frameAs(encode: (pipeline: Sharp) => Sharp): Promise<Uint8Array> {
    const pipeline = sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    });
    return new Uint8Array(await encode(pipeline).toBuffer());
  }

  it('names every buffer-input format this build decodes', async () => {
    // The upload surfaces accept the first three; the rest are what a mislabeled
    // part can smuggle past a declared `Content-Type` — including HEIF, which
    // this build decodes rather than refusing.
    const cases: Array<[string, (p: Sharp) => Sharp]> = [
      ['jpeg', (p) => p.jpeg()],
      ['png', (p) => p.png()],
      ['webp', (p) => p.webp()],
      ['gif', (p) => p.gif()],
      ['tiff', (p) => p.tiff()],
      ['heif', (p) => p.heif({ compression: 'av1' })],
    ];
    for (const [format, encode] of cases) {
      expect(await detectImageFormat(await frameAs(encode))).toBe(format);
    }
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    );
    expect(await detectImageFormat(svg)).toBe('svg');
  });

  it('answers null for bytes that are not an image at all', async () => {
    expect(await detectImageFormat(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(await detectImageFormat(new Uint8Array())).toBeNull();
  });
});
