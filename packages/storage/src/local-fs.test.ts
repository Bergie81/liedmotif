import { mkdir, mkdtemp, rm, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeStorageAdapterContract } from './adapter-contract';
import { localFsStorageProvider } from './local-fs';
import { StorageKeyError } from './safe-key';
import type { StorageProvider } from './index';

// Interface semantics live in the shared adapter contract suite; this file
// keeps only the behavior specific to the filesystem adapter — on-disk layout,
// temp-file hygiene, directory pruning, and symlink/traversal confinement
// beyond the lexical check.

describeStorageAdapterContract('local-fs', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-storage-contract-'));
  return {
    storage: localFsStorageProvider({ dataRoot }),
    cleanup: () => rm(dataRoot, { recursive: true, force: true }),
  };
});

describe('localFsStorageProvider', () => {
  let dataRoot: string;
  let storage: StorageProvider;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-storage-'));
    storage = localFsStorageProvider({ dataRoot });
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('identifies itself as the local-fs adapter', () => {
    expect(storage.providerKey).toBe('local-fs');
  });

  it('leaves no leftover temp file when a streamed write fails mid-flight', async () => {
    const key = 'tracks/u/t/original.mp3';
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('network died mid-download'));
      },
    });
    await expect(storage.write({ key, body: failing })).rejects.toThrow('network died');
    // No partial object, and no leftover *.tmp file in the directory.
    expect(await storage.stat(key)).toBeNull();
    const entries = await readdir(path.join(dataRoot, 'tracks/u/t'));
    expect(entries).toEqual([]);
  });

  it('rejects reading a directory key', async () => {
    await storage.write({ key: 'tracks/u/t/original.mp3', body: Buffer.from('x') });
    await expect(storage.readStream('tracks/u/t')).rejects.toThrow(StorageKeyError);
  });

  it('reports why a ranged read failed, not why its cleanup did', async () => {
    const key = 'tracks/u/t/original.mp3';
    await storage.write({ key, body: Buffer.from('twenty bytes exactly') });
    // An offset no file can hold: opening the stream fails, and closing the
    // handle afterwards fails too — the caller must still learn the first.
    await expect(storage.readStreamWithStat!(key, { start: 1e21 })).rejects.toMatchObject({
      code: 'ERR_OUT_OF_RANGE',
    });
  });

  it('removes an empty session cover directory after concurrent cover deletion', async () => {
    const sessionDir = path.join(dataRoot, 'covers/generated/user-1/session-4');
    await storage.write({
      key: 'covers/generated/user-1/session-4/cover-1.webp',
      body: Buffer.from('one'),
    });
    await storage.write({
      key: 'covers/generated/user-1/session-4/cover-2.webp',
      body: Buffer.from('two'),
    });
    await storage.write({
      key: 'covers/generated/user-1/session-5/cover-3.webp',
      body: Buffer.from('three'),
    });

    await Promise.all([
      storage.delete('covers/generated/user-1/session-4/cover-1.webp'),
      storage.delete('covers/generated/user-1/session-4/cover-2.webp'),
    ]);

    await expect(readdir(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readdir(path.join(dataRoot, 'covers/generated/user-1/session-5')),
    ).resolves.toEqual(['cover-3.webp']);
    await expect(readdir(dataRoot)).resolves.toEqual(['covers']);
  });

  describe('interrupted-write sweep', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** Plant a temp file of the shape `write` stages through, aged as given. */
    async function plantTemp(relative: string, ageMs: number): Promise<string> {
      const absolute = path.join(dataRoot, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, 'partial');
      const when = new Date(Date.now() - ageMs);
      await utimes(absolute, when, when);
      return absolute;
    }

    it('unlinks only stale temp files, leaving in-flight writes and objects alone', async () => {
      await storage.write({ key: 'tracks/u/t/original.mp3', body: Buffer.from('kept') });
      const stale = await plantTemp('tracks/u/t/original.mp3.a1b2c3d4e5f6.tmp', 2 * DAY_MS);
      const fresh = await plantTemp('tracks/u/t/original.mp3.0f1e2d3c4b5a.tmp', 60_000);

      expect(await storage.sweepInterruptedWrites!(new Date(Date.now() - DAY_MS))).toBe(1);

      const remaining = await readdir(path.dirname(stale));
      expect(remaining).toContain('original.mp3');
      expect(remaining).toContain(path.basename(fresh));
      expect(remaining).not.toContain(path.basename(stale));
    });

    it('never leaves the data root through a planted directory symlink', async () => {
      const outside = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-outside-'));
      await writeFile(path.join(outside, 'victim.a1b2c3d4e5f6.tmp'), 'not ours');
      const old = new Date(Date.now() - 10 * DAY_MS);
      await utimes(path.join(outside, 'victim.a1b2c3d4e5f6.tmp'), old, old);
      await mkdir(path.join(dataRoot, 'covers'), { recursive: true });
      await symlink(outside, path.join(dataRoot, 'covers', 'escape-dir'));
      try {
        expect(await storage.sweepInterruptedWrites!(new Date(Date.now() - DAY_MS))).toBe(0);
        expect(await readdir(outside)).toEqual(['victim.a1b2c3d4e5f6.tmp']);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('builds a read URL that never exposes the filesystem path', async () => {
    const url = await storage.createReadUrl('tracks/user-1/track-9/original.mp3');
    expect(url.startsWith('file:')).toBe(false);
    expect(url).not.toContain(dataRoot);
  });

  it('honors a configured read URL base', async () => {
    const custom = localFsStorageProvider({ dataRoot, readUrlBase: '/api/audio' });
    const url = await custom.createReadUrl('tracks/u/t/original.mp3');
    expect(url.startsWith('/api/audio/')).toBe(true);
  });

  describe('path-traversal confinement', () => {
    it('writes nothing inside or outside the root for a rejected traversal key', async () => {
      for (const key of ['../escape.mp3', 'tracks/../../escape.mp3', '/etc/passwd', '~/escape']) {
        await expect(storage.write({ key, body: Buffer.from('x') })).rejects.toThrow(
          StorageKeyError,
        );
      }
      // The data root has no stray files from the rejected writes.
      expect(await readdir(dataRoot)).toEqual([]);
      // Nothing leaked into the parent directory either.
      const parentEntries = await readdir(path.dirname(dataRoot));
      expect(parentEntries).not.toContain('escape.mp3');
    });

    it('cannot read a file that exists outside the root via a traversal key', async () => {
      const secret = path.join(path.dirname(dataRoot), 'outside-secret.txt');
      await writeFile(secret, 'top secret');
      try {
        const traversal = `../${path.basename(secret)}`;
        await expect(storage.readStream(traversal)).rejects.toThrow(StorageKeyError);
      } finally {
        await rm(secret, { force: true });
      }
    });

    it('cannot follow a file symlink planted inside the root to escape', async () => {
      const secret = path.join(path.dirname(dataRoot), 'outside-secret.txt');
      await writeFile(secret, 'top secret');
      await storage.write({ key: 'covers/real.webp', body: Buffer.from('x') }); // create covers/
      await symlink(secret, path.join(dataRoot, 'covers', 'leak.txt'));
      try {
        await expect(storage.readStream('covers/leak.txt')).rejects.toThrow(StorageKeyError);
        await expect(storage.stat('covers/leak.txt')).rejects.toThrow(StorageKeyError);
      } finally {
        await rm(secret, { force: true });
      }
    });

    it('cannot write through a directory symlink that points outside the root', async () => {
      const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-outside-'));
      await symlink(outsideDir, path.join(dataRoot, 'escape-dir'));
      try {
        await expect(
          storage.write({ key: 'escape-dir/planted.mp3', body: Buffer.from('x') }),
        ).rejects.toThrow(StorageKeyError);
        expect(await readdir(outsideDir)).toEqual([]);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
