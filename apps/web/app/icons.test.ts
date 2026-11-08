// The committed icon assets are what browsers and Android actually load — a
// missing or malformed file 404s the tab icon or downgrades the PWA install to
// a shortcut. These tests pin existence, dimensions, and format at build time
// (no browser needed): sharp decodes the PNGs/SVG; the ICO header is parsed by
// hand because sharp cannot read ICO containers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const asset = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Android composites transparent pixels over arbitrary launcher backgrounds, so
// every rasterized icon must be fully opaque (3 channels, no alpha).
async function expectOpaquePng(path: string, size: number): Promise<void> {
  const meta = await sharp(path).metadata();
  expect(meta.format).toBe('png');
  expect(meta.width).toBe(size);
  expect(meta.height).toBe(size);
  expect(meta.hasAlpha).toBe(false);
}

describe('icon assets', () => {
  it('ships the scalable SVG favicon as an app file convention', async () => {
    const meta = await sharp(asset('./icon.svg')).metadata();
    expect(meta.format).toBe('svg');
  });

  it('ships a multi-size ICO favicon', () => {
    const ico = readFileSync(asset('./favicon.ico'));
    // ICONDIR header: reserved 0, type 1 (icon), then the image count.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(2);
    // Each ICONDIRENTRY is 16 bytes; width/height of 0 means 256.
    const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16) || 256);
    expect(sizes).toContain(16);
    expect(sizes).toContain(32);
  });

  it('ships an opaque 180x180 Apple touch icon', async () => {
    await expectOpaquePng(asset('./apple-icon.png'), 180);
  });

  it('ships opaque 192 and 512 manifest PNGs', async () => {
    await expectOpaquePng(asset('../public/icons/icon-192.png'), 192);
    await expectOpaquePng(asset('../public/icons/icon-512.png'), 512);
  });

  it('ships an opaque 512 maskable PNG with the mark inside the safe zone', async () => {
    const path = asset('../public/icons/icon-512-maskable.png');
    await expectOpaquePng(path, 512);
    // Maskable safe zone: a centered circle of 40% radius. Everything outside it
    // must be pure background so circle cropping never clips the mark. The four
    // sampled points sit on the diagonals at ~49% radius — clear of the safe
    // circle, well inside the canvas corners.
    const raw = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = raw.info;
    const px = (x: number, y: number) =>
      Array.from(raw.data.subarray((y * width + x) * channels, (y * width + x) * channels + 3));
    const background = px(2, 2);
    for (const [x, y] of [
      [80, 80],
      [431, 80],
      [80, 431],
      [431, 431],
    ] as const) {
      expect(px(x, y), `pixel at ${x},${y} should be background`).toEqual(background);
    }
  });
});
