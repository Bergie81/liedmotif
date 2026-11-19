import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Learned taste ranks fine-tune suggestions and selects
// Surprise Me proposals, and nothing else. An ordinary prompted Session
// compiles, and a running Session tops up, without ever reading it — so the
// read may only be reached from the surfaces that suggest, never from intent
// compilation, the worker, or a provider.

const ROOT = join(__dirname, '..', '..', '..');
const TASTE_READS = /\b(getLearnedTaste|getCachedLearnedTaste|rankForYouGenres)\b/;
const ALLOWED = new Set(['apps/web/app/(app)/page.tsx', 'apps/web/lib/sessions/surprise-me.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.next', 'dist', 'tests'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('learned taste stays out of ordinary Sessions', () => {
  it('is read only by the Home fine-tune suggestions and Surprise Me', () => {
    const readers = ['apps/web', 'apps/worker', 'packages/providers', 'packages/shared']
      .flatMap((root) => sources(join(ROOT, root)))
      .filter((path) => TASTE_READS.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(new Set(readers)).toEqual(ALLOWED);
  });

  it('is read by no generation code in the database package', () => {
    const readers = sources(join(ROOT, 'packages/db/src/generation'))
      .filter((path) => TASTE_READS.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(readers).toEqual([]);
  });
});
