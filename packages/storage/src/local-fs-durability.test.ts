// Verifies the atomic-write durability contract: the temp file is
// written with `flush: true` (fsync before close), then renamed into place, and
// only then are the destination's ancestor directories fsynced (leaf parent up
// to the data root) — so a power loss cannot leave a zero-length "final" object
// or lose a freshly created directory chain. fsync has no observable filesystem
// effect, so these tests wrap the fs modules and record an ordered event log.
// The same wrap lets a test run a sibling delete right after a write's `mkdir`,
// or fail a delete's directory prune.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localFsStorageProvider } from './local-fs';

const recorded = vi.hoisted(() => ({
  writeFileOptions: [] as unknown[],
  writeStreamOptions: [] as unknown[],
  events: [] as string[],
  /** One-shot hook run right after the next `mkdir` resolves. */
  afterMkdir: null as null | (() => Promise<void>),
  /** Error code every `rmdir` fails with while set. */
  rmdirErrorCode: null as null | string,
  reset() {
    this.writeFileOptions.length = 0;
    this.writeStreamOptions.length = 0;
    this.events.length = 0;
    this.afterMkdir = null;
    this.rmdirErrorCode = null;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createWriteStream: typeof actual.createWriteStream = (...args) => {
    recorded.writeStreamOptions.push(args[1]);
    recorded.events.push('write-temp');
    return actual.createWriteStream(...args);
  };
  return { ...actual, createWriteStream };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof actual.writeFile = (...args) => {
    recorded.writeFileOptions.push(args[2]);
    recorded.events.push('write-temp');
    return actual.writeFile(...args);
  };
  const rename: typeof actual.rename = (...args) => {
    recorded.events.push('rename');
    return actual.rename(...args);
  };
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      recorded.events.push(`sync:${String(args[0])}`);
      return originalSync();
    };
    return handle;
  };
  const mkdir = (async (...args: Parameters<typeof actual.mkdir>) => {
    const created = await actual.mkdir(...args);
    const hook = recorded.afterMkdir;
    recorded.afterMkdir = null;
    await hook?.();
    return created;
  }) as typeof actual.mkdir;
  const rmdir: typeof actual.rmdir = async (...args) => {
    const code = recorded.rmdirErrorCode;
    if (code) throw Object.assign(new Error(`${code}: rmdir`), { code });
    return actual.rmdir(...args);
  };
  return { ...actual, writeFile, rename, open, mkdir, rmdir };
});

describe('localFsStorageProvider write durability', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'liedmotif-durability-'));
    recorded.reset();
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('flushes a buffer write, renames, then fsyncs every ancestor directory', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await storage.write({ key: 'tracks/u/t/original.mp3', body: Buffer.from('audio') });

    expect(recorded.writeFileOptions).toEqual([{ flush: true }]);
    expect(recorded.events).toEqual([
      'write-temp',
      'rename',
      `sync:${path.join(dataRoot, 'tracks/u/t')}`,
      `sync:${path.join(dataRoot, 'tracks/u')}`,
      `sync:${path.join(dataRoot, 'tracks')}`,
      `sync:${dataRoot}`,
    ]);
  });

  it('flushes a streamed write, renames, then fsyncs every ancestor directory', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await storage.write({
      key: 'covers/uploaded/blue.webp',
      body: Readable.from(Buffer.from('img')),
    });

    expect(recorded.writeStreamOptions).toEqual([expect.objectContaining({ flush: true })]);
    expect(recorded.events).toEqual([
      'write-temp',
      'rename',
      `sync:${path.join(dataRoot, 'covers/uploaded')}`,
      `sync:${path.join(dataRoot, 'covers')}`,
      `sync:${dataRoot}`,
    ]);
  });

  it('neither renames nor fsyncs when the write fails before the rename', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    const failing = new Readable({
      read() {
        this.destroy(new Error('network died mid-download'));
      },
    });
    await expect(storage.write({ key: 'tracks/u/t/original.mp3', body: failing })).rejects.toThrow(
      'network died',
    );
    expect(recorded.events).toEqual(['write-temp']);
  });

  it('stores a write whose fresh folder a sibling delete prunes right after mkdir', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await storage.write({ key: 'covers/generated/u/s/old.webp', body: Buffer.from('old') });
    recorded.afterMkdir = () => storage.delete('covers/generated/u/s/old.webp');

    await storage.write({ key: 'covers/generated/u/s/new.webp', body: Buffer.from('new') });

    expect(await storage.stat('covers/generated/u/s/new.webp')).not.toBeNull();
    expect(await storage.stat('covers/generated/u/s/old.webp')).toBeNull();
  });

  it('streams a write whose fresh folder a sibling delete prunes right after mkdir', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await storage.write({ key: 'tracks/u/s/a.mp3', body: Buffer.from('a') });
    recorded.afterMkdir = () => storage.delete('tracks/u/s/a.mp3');

    await storage.write({ key: 'tracks/u/s/b.mp3', body: Readable.from(Buffer.from('b')) });

    expect(await storage.stat('tracks/u/s/b.mp3')).not.toBeNull();
  });

  it('reports a delete as done once the file is gone, even when pruning its folder fails', async () => {
    const storage = localFsStorageProvider({ dataRoot });
    await storage.write({ key: 'tracks/u/s/a.mp3', body: Buffer.from('a') });
    recorded.rmdirErrorCode = 'EBUSY';

    await expect(storage.delete('tracks/u/s/a.mp3')).resolves.toBeUndefined();
    expect(await storage.stat('tracks/u/s/a.mp3')).toBeNull();
  });
});
