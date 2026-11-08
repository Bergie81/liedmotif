// The Liedmotif brand overlay: the committed SVG (authored at the exact
// normalized cover dimensions, badge bottom-left) is rasterized once per
// process for the album-art rendition — the ONE place the badge is composited,
// so only files that leave the app carry it while stored Covers stay clean.
//
// The asset is the raw design export: it may carry a full-canvas placeholder
// `<rect id="cover">` used for design preview, which the loader strips so the
// badge lands on a transparent background. Updating the badge is therefore a
// plain file overwrite of `packages/media/assets/branding/cover-brand-overlay.svg`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NORMALIZED_COVER_EDGE } from './cover-quality';

const OVERLAY_PACKAGE_PATH = [
  'packages',
  'media',
  'assets',
  'branding',
  'cover-brand-overlay.svg',
] as const;
/**
 * The design-preview backdrop; everything else in the asset is the badge
 * itself. Both self-closing and paired forms must strip — a paired-form export
 * left in place would render a full-canvas opaque rect over every cover.
 */
const PLACEHOLDER_RECT = /<rect[^>]*\bid="cover"[^>]*(?:\/>|>[\s\S]*?<\/rect>)/;

/** Exported for tests only: the overlay-load derivation must stay covered. */
export function stripPlaceholderRect(svg: string): string {
  return svg.replace(PLACEHOLDER_RECT, '');
}

/**
 * Both apps render embedded album art, and each reaches this file differently:
 * from source (worker `tsx`, Vitest, Next dev) the package layout resolves
 * relative to this module, while a bundler that inlines the source leaves only the
 * process cwd — the monorepo root for the worker image and the Next standalone
 * server, an `apps/*` directory for either dev server. Webpack rewrites the
 * module-relative `new URL(...)` into its own asset-URL wrapper class, which
 * `fileURLToPath` rejects — that candidate is guarded so resolution degrades to
 * the cwd candidates every bundled runtime satisfies (the Next config's
 * `outputFileTracingIncludes` entry ships the asset directory explicitly).
 *
 * Exported for tests only: nothing in a source run exercises the cwd candidates
 * or the degradation, and `moduleRelative` is injectable so a test can force the
 * latter.
 */
export function overlayPathCandidates(
  cwd: string,
  moduleRelative: () => string = () =>
    fileURLToPath(new URL('../assets/branding/cover-brand-overlay.svg', import.meta.url)),
): string[] {
  return [
    ...attemptCandidate(moduleRelative),
    join(cwd, ...OVERLAY_PACKAGE_PATH),
    join(cwd, '..', '..', ...OVERLAY_PACKAGE_PATH),
  ];
}

/** The resolved path, or no candidate at all when resolving it throws. */
function attemptCandidate(resolve: () => string): string[] {
  try {
    return [resolve()];
  } catch {
    return [];
  }
}

function resolveOverlayPath(): string {
  const candidates = overlayPathCandidates(process.cwd());
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Cover brand overlay asset not found (looked in: ${candidates.join(', ')})`);
  }
  return found;
}

let overlayPromise: Promise<Buffer> | null = null;

/**
 * The brand badge rasterized once per process at the normalized cover edge
 * (square, transparent background). The album-art rendition rescales it when a
 * decoded cover is not at that edge.
 */
export function rasterizedBrandOverlay(): Promise<Buffer> {
  overlayPromise ??= (async () => {
    const svg = stripPlaceholderRect(readFileSync(resolveOverlayPath(), 'utf8'));
    return sharp(Buffer.from(svg))
      .resize(NORMALIZED_COVER_EDGE, NORMALIZED_COVER_EDGE, { fit: 'fill' })
      .png()
      .toBuffer();
  })().catch((error: unknown) => {
    overlayPromise = null;
    throw error;
  });
  return overlayPromise;
}
