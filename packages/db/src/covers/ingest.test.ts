import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localFsStorageProvider } from '@liedmotif/storage';
import { coverImages } from '../schema';
import { ensurePlaceholderCover } from '../seed';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { ingestPlaceholderCover, placeholderAssetCandidates } from './ingest';
import { PLACEHOLDER_COVER_ID, PLACEHOLDER_COVER_STORAGE_KEY } from './placeholder';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describe('placeholder asset resolution', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

  // A source run always resolves through this module's own location (the ingest
  // cases below prove it), so only the cwd candidates prove that a bundled app —
  // the Next standalone server provisioning or serving the placeholder — finds
  // the WebP.
  it.each([
    ['the monorepo root', repoRoot],
    ['the web app', path.join(repoRoot, 'apps', 'web')],
  ])('finds the asset from %s without this module’s own location', (_context, cwd) => {
    const [, ...cwdCandidates] = placeholderAssetCandidates(cwd);
    expect(cwdCandidates.some((candidate) => existsSync(candidate))).toBe(true);
  });

  // Webpack rewrites the module-relative `new URL(...)` into its own asset-URL
  // wrapper, which `fileURLToPath` rejects — the covers route's placeholder
  // self-heal must degrade to the cwd candidates instead of throwing while
  // building the list.
  it('degrades to the cwd candidates when the module-relative resolution throws', () => {
    const [, ...cwdCandidates] = placeholderAssetCandidates(repoRoot);
    expect(
      placeholderAssetCandidates(repoRoot, () => {
        throw new TypeError('cross-realm URL instance');
      }),
    ).toEqual(cwdCandidates);
  });
});

describe('ingestPlaceholderCover (storage finalization)', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-covers-'));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('copies the bundled bytes under the canonical key', async () => {
    const storage = localFsStorageProvider({ dataRoot });

    expect(await ingestPlaceholderCover(storage)).toBe('written');
    expect(existsSync(path.join(dataRoot, PLACEHOLDER_COVER_STORAGE_KEY))).toBe(true);
  });

  it('is idempotent: a second run re-copies nothing', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await ingestPlaceholderCover(storage);

    const onDisk = path.join(dataRoot, PLACEHOLDER_COVER_STORAGE_KEY);
    const mtimeBefore = (await stat(onDisk)).mtimeMs;

    expect(await ingestPlaceholderCover(storage)).toBe('skipped');

    // The existing object was left untouched (same mtime → not rewritten).
    expect((await stat(onDisk)).mtimeMs).toBe(mtimeBefore);
  });

  it('self-heals a wrong-sized object on re-ingest', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await storage.write({ key: PLACEHOLDER_COVER_STORAGE_KEY, body: new Uint8Array([1, 2, 3]) });

    expect(await ingestPlaceholderCover(storage)).toBe('written');
  });
});

describeIfDb('ensurePlaceholderCover (row + bytes)', () => {
  let ctx: TestDb;
  let dataRoot: string;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-covers-ingest-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['cover_images']);
    dataRoot = await mkdtemp(path.join(tmpdir(), 'liedmotif-covers-'));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('seeds the placeholder row and ingests its bytes', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    expect(await ensurePlaceholderCover(ctx.db, storage)).toBe('written');

    const rows = await ctx.db.select().from(coverImages);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(PLACEHOLDER_COVER_ID);
    expect(existsSync(path.join(dataRoot, rows[0]!.storageKey))).toBe(true);
  });

  it('is idempotent across both the row and the bytes', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await ensurePlaceholderCover(ctx.db, storage);

    expect(await ensurePlaceholderCover(ctx.db, storage)).toBe('skipped');
    expect(await ctx.db.select().from(coverImages)).toHaveLength(1);
  });
});
