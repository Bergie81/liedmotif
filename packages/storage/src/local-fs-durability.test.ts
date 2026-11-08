// Verifies the atomic-write durability contract: the temp file is
// written with `flush: true` (fsync before close), then renamed into place, and
// only then are the destination's ancestor directories fsynced (leaf parent up
// to the data root) — so a power loss cannot leave a zero-length "final" object
// or lose a freshly created directory chain. fsync has no observable filesystem
// effect, so these tests wrap the fs modules and record an ordered event log.

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
  reset() {
    this.writeFileOptions.length = 0;
    this.writeStreamOptions.length = 0;
    this.events.length = 0;
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
  return { ...actual, writeFile, rename, open };
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
});
