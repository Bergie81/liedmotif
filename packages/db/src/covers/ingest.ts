// Placeholder-cover storage finalization.
//
// Seeding writes the `cover_images` ROW; this writes the cover BYTES. The bundled
// asset ships inside the package, but covers must be servable from the `/data`
// storage volume under their canonical key (served through an app route
// from storage, never a public static path).
//
// The sink is the storage provider, accepted structurally (a `StorageProvider` is
// assignable) so `@liedmotif/db`'s core never has to depend on `@liedmotif/storage`
// — only the `db:seed` CLI binds the concrete local-fs provider.

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_COVER_STORAGE_KEY } from './placeholder';

/**
 * The minimal storage surface cover ingestion needs — a structural subset of
 * `StorageProvider` (so the real provider is assignable without importing it).
 */
export interface CoverStorageSink {
  /** Object metadata, or `null` when the key is absent. */
  stat(key: string): Promise<{ byteSize: number } | null>;
  /** Write object bytes under `key`. */
  write(input: { key: string; body: Uint8Array; mimeType?: string }): Promise<unknown>;
}

/** Whether this run copied the bytes or found a healthy object already there. */
export type IngestOutcome = 'written' | 'skipped';

const ASSET_PACKAGE_PATH = ['packages', 'db', 'assets', 'covers', 'placeholder.webp'] as const;

/**
 * Every runtime reaches this file differently: from source (worker `tsx`, Vitest,
 * Next dev) the package layout resolves relative to this module, while a bundler
 * that inlines the source leaves only the process cwd — the monorepo root for the
 * Next standalone server, an `apps/*` directory for either dev server. Webpack
 * rewrites the module-relative `new URL(...)` into its own asset-URL wrapper
 * class, which `fileURLToPath` rejects — that candidate is guarded so resolution
 * degrades to the cwd candidates every bundled runtime satisfies (the Next
 * config's `outputFileTracingIncludes` entry ships the asset directory
 * explicitly).
 *
 * Exported for tests only: nothing in a source run exercises the cwd candidates
 * or the degradation, and `moduleRelative` is injectable so a test can force the
 * latter.
 */
export function placeholderAssetCandidates(
  cwd: string,
  moduleRelative: () => string = () =>
    fileURLToPath(new URL('../../assets/covers/placeholder.webp', import.meta.url)),
): string[] {
  return [
    ...attemptCandidate(moduleRelative),
    join(cwd, ...ASSET_PACKAGE_PATH),
    join(cwd, '..', '..', ...ASSET_PACKAGE_PATH),
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

function resolveAssetPath(): string {
  const candidates = placeholderAssetCandidates(process.cwd());
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Placeholder cover asset not found (looked in: ${candidates.join(', ')})`);
  }
  return found;
}

/**
 * Copy the bundled placeholder-cover bytes into storage under their canonical
 * key. Skips only when storage already holds an object of the SAME size as the
 * bundled asset, so a missing, empty, or wrong-sized object is (re)written and a
 * truncated/corrupted cover self-heals while a correct one is left untouched.
 */
export async function ingestPlaceholderCover(sink: CoverStorageSink): Promise<IngestOutcome> {
  const sourcePath = resolveAssetPath();
  const sourceSize = (await stat(sourcePath)).size;
  const existing = await sink.stat(PLACEHOLDER_COVER_STORAGE_KEY);
  if (existing && existing.byteSize === sourceSize) return 'skipped';
  await sink.write({
    key: PLACEHOLDER_COVER_STORAGE_KEY,
    body: await readFile(sourcePath),
    mimeType: 'image/webp',
  });
  return 'written';
}
