// One-time icon generation: rasterizes the SVG mark (the single design source)
// into the committed favicon/PWA/Apple icon assets. Re-run with
// `npm run icons:generate` after changing the mark; outputs are committed
// static files, not a build step.
//
// Rasterization drops the SVG's `prefers-color-scheme` CSS, so every raster
// bakes the dark-theme colors — matching the manifest's `#09090b` background.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(repoRoot, 'apps/web/app');
const iconsDir = join(repoRoot, 'apps/web/public/icons');

const BACKGROUND = '#09090b';
// Fraction of the square canvas the mark occupies on non-maskable icons —
// enough padding to read as an app tile without looking letterboxed.
const MARK_SCALE = 0.75;
// Maskable icons may be cropped to a centered circle of this radius (as a
// fraction of the canvas), so the whole mark has to fit inside it.
const MASKABLE_SAFE_RADIUS = 0.4;
// The mark's content bounds inside its 24-unit viewBox — bars span x 3–21
// (half-width 9) and y 1.5–22.5 (half-height 10.5) — so its farthest corner
// sits at this radius when the mark fills the canvas edge to edge.
const MARK_CONTENT_RADIUS = Math.hypot(9, 10.5) / 24;
// Shrinks the mark until that farthest corner lands on the safe-zone edge.
const MASKABLE_SCALE = MASKABLE_SAFE_RADIUS / MARK_CONTENT_RADIUS;
// Legacy favicon sizes Windows and older browsers pick between.
const ICO_SIZES = [16, 32, 48];

const svgSource = readFileSync(join(appDir, 'icon.svg'));

function renderMark(markSize: number): Promise<Buffer> {
  return sharp(svgSource).resize(markSize, markSize).png().toBuffer();
}

// Opaque square icon: the mark at `scale` of the canvas, centered on the app
// background. Android composites transparent pixels over arbitrary launcher
// backgrounds, so rasterized icons must carry no alpha channel at all.
async function opaqueIcon(canvasSize: number, scale: number): Promise<Buffer> {
  const mark = await renderMark(Math.round(canvasSize * scale));
  const composited = await sharp({
    create: { width: canvasSize, height: canvasSize, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer();
  // `flatten` runs before `composite` within a single sharp pipeline, so
  // dropping the alpha channel needs a second pass over the result.
  return sharp(composited).flatten({ background: BACKGROUND }).png().toBuffer();
}

// ICO container with PNG-encoded entries (supported by all current browsers and
// Windows since Vista). Layout: ICONDIR (6 bytes), one 16-byte ICONDIRENTRY per
// image, then the raw PNG payloads.
function buildIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  let offset = header.length + images.length * 16;
  for (const { size, data } of images) {
    // Width and height are single bytes, so the format spells 256 as 0.
    const dimension = size === 256 ? 0 : size;
    const entry = Buffer.alloc(16);
    entry.writeUInt8(dimension, 0); // width
    entry.writeUInt8(dimension, 1); // height
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

async function main(): Promise<void> {
  mkdirSync(iconsDir, { recursive: true });

  // Tab favicon: transparent background, so the bars stay readable on light and
  // dark tabs alike.
  const icoImages = await Promise.all(
    ICO_SIZES.map(async (size) => ({ size, data: await renderMark(size) })),
  );
  writeFileSync(join(appDir, 'favicon.ico'), buildIco(icoImages));

  writeFileSync(join(appDir, 'apple-icon.png'), await opaqueIcon(180, MARK_SCALE));
  writeFileSync(join(iconsDir, 'icon-192.png'), await opaqueIcon(192, MARK_SCALE));
  writeFileSync(join(iconsDir, 'icon-512.png'), await opaqueIcon(512, MARK_SCALE));
  writeFileSync(join(iconsDir, 'icon-512-maskable.png'), await opaqueIcon(512, MASKABLE_SCALE));

  console.log('Icons written to apps/web/app and apps/web/public/icons.');
}

await main();
