import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { evaluateCoverImage } from './cover-quality';

/** A PNG with per-pixel variation (a diagonal ramp), so it is never "blank". */
async function texturedPng(width: number, height: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      raw[offset] = (x * 7 + y * 13) % 256;
      raw[offset + 1] = (x * 3) % 256;
      raw[offset + 2] = (y * 5) % 256;
    }
  }
  return new Uint8Array(
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 40, g: 40, b: 40 } },
    })
      .png()
      .toBuffer(),
  );
}

describe('evaluateCoverImage', () => {
  it('accepts a square, textured image at or above the minimum size', async () => {
    const verdict = await evaluateCoverImage(await texturedPng(512, 512));
    expect(verdict).toEqual({ ok: true, width: 512, height: 512 });
  });

  it('accepts a near-square image (safely croppable)', async () => {
    const verdict = await evaluateCoverImage(await texturedPng(640, 512));
    expect(verdict.ok).toBe(true);
  });

  it('rejects bytes that do not decode as an image', async () => {
    const verdict = await evaluateCoverImage(new Uint8Array([1, 2, 3, 4, 5]));
    expect(verdict).toEqual({ ok: false, reason: 'undecodable' });
  });

  it('rejects an image below the minimum dimensions', async () => {
    const verdict = await evaluateCoverImage(await texturedPng(256, 256));
    expect(verdict).toEqual({ ok: false, reason: 'too_small' });
  });

  it('rejects a clearly non-square image', async () => {
    const verdict = await evaluateCoverImage(await texturedPng(1024, 512));
    expect(verdict).toEqual({ ok: false, reason: 'not_square' });
  });

  it('rejects a blank (solid-color) image', async () => {
    const verdict = await evaluateCoverImage(await solidPng(512, 512));
    expect(verdict).toEqual({ ok: false, reason: 'blank' });
  });
});
