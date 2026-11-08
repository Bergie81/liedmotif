// Shared adapter contract suite. Every `StorageProvider` adapter must behave
// identically at the interface — this file encodes those semantics once, and
// each adapter's test file runs it against a real instance (`local-fs` on a
// temp directory; `s3` against an S3 server started like the test database). Only
// externally observable behavior belongs here; adapter-specific mechanics
// (symlink confinement, directory pruning, multipart internals) stay in the
// adapter's own test file.

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageKeyError } from './safe-key';
import { readAllBytes, type StorageProvider } from './index';

export interface StorageContractHarness {
  storage: StorageProvider;
  cleanup?: () => Promise<void>;
}

async function collect(stream: Readable): Promise<Buffer> {
  return Buffer.from(await readAllBytes(stream));
}

/** A body that emits some bytes, then fails — a download dying mid-stream. */
function failingBody(): Readable {
  return new Readable({
    read() {
      this.push(Buffer.from('partial'));
      this.destroy(new Error('network died mid-download'));
    },
  });
}

export function describeStorageAdapterContract(
  name: string,
  createHarness: () => Promise<StorageContractHarness> | StorageContractHarness,
): void {
  describe(`storage adapter contract: ${name}`, () => {
    let harness: StorageContractHarness;
    let storage: StorageProvider;

    beforeEach(async () => {
      harness = await createHarness();
      storage = harness.storage;
    });

    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('round-trips a buffer write through readStream', async () => {
      const key = 'tracks/user-1/track-9/original.mp3';
      const body = Buffer.from('the audio bytes');
      const stat = await storage.write({ key, body, mimeType: 'audio/mpeg' });

      expect(stat.key).toBe(key);
      expect(stat.byteSize).toBe(body.byteLength);
      expect(stat.mimeType).toBe('audio/mpeg');
      expect(stat.updatedAt).toBeInstanceOf(Date);

      const read = await collect(await storage.readStream(key));
      expect(read.equals(body)).toBe(true);
    });

    it('round-trips a Readable stream write', async () => {
      const key = 'covers/uploaded/u/blue.webp';
      const body = Buffer.from('imagedata');
      const stat = await storage.write({ key, body: Readable.from(body) });
      expect(stat.byteSize).toBe(body.byteLength);

      const read = await collect(await storage.readStream(key));
      expect(read.equals(body)).toBe(true);
    });

    it('writes a zero-byte object and overwrites an existing key', async () => {
      const key = 'tracks/u/t/original.mp3';
      const empty = await storage.write({ key, body: Buffer.alloc(0) });
      expect(empty.byteSize).toBe(0);
      expect(await collect(await storage.readStream(key))).toHaveLength(0);

      const replaced = await storage.write({ key, body: Buffer.from('longer payload') });
      expect(replaced.byteSize).toBe('longer payload'.length);
      const read = await collect(await storage.readStream(key));
      expect(read.toString()).toBe('longer payload');
    });

    it('reads inclusive byte ranges: start+end, start-only, end-only, past-the-end', async () => {
      const key = 'tracks/u/t/original.mp3';
      await storage.write({ key, body: Buffer.from('0123456789') });

      const bounded = await collect(await storage.readStream(key, { start: 2, end: 5 }));
      expect(bounded.toString()).toBe('2345');

      const toEnd = await collect(await storage.readStream(key, { start: 7 }));
      expect(toEnd.toString()).toBe('789');

      const fromStart = await collect(await storage.readStream(key, { end: 3 }));
      expect(fromStart.toString()).toBe('0123');

      const clamped = await collect(await storage.readStream(key, { start: 4, end: 999 }));
      expect(clamped.toString()).toBe('456789');

      // A start at/past the object size yields an empty stream, not an error.
      const pastEnd = await collect(await storage.readStream(key, { start: 10 }));
      expect(pastEnd).toHaveLength(0);
    });

    it('rejects reading a missing key before any stream is returned', async () => {
      await expect(storage.readStream('tracks/u/t/missing.mp3')).rejects.toThrow();
      await expect(storage.readStream('tracks/u/t/missing.mp3', { start: 3 })).rejects.toThrow();
    });

    it('prefers the caller-supplied content type and falls back to the key-derived one', async () => {
      const supplied = await storage.write({
        key: 'covers/uploaded/u/cover.bin',
        body: Buffer.from('img'),
        mimeType: 'image/webp',
      });
      expect(supplied.mimeType).toBe('image/webp');

      const derived = await storage.write({
        key: 'tracks/u/t/original.mp3',
        body: Buffer.from('a'),
      });
      expect(derived.mimeType).toBe('audio/mpeg');

      const unknown = await storage.write({ key: 'imports/u/b.bin', body: Buffer.from('a') });
      expect(unknown.mimeType).toBe('application/octet-stream');
    });

    it('stats an existing object and returns null for a missing one', async () => {
      const key = 'tracks/u/t/original.mp3';
      await storage.write({ key, body: Buffer.from('xyz') });

      const stat = await storage.stat(key);
      expect(stat?.key).toBe(key);
      expect(stat?.byteSize).toBe(3);
      expect(stat?.mimeType).toBe('audio/mpeg');
      expect(stat?.updatedAt).toBeInstanceOf(Date);

      expect(await storage.stat('tracks/u/t/missing.mp3')).toBeNull();
    });

    it('deletes an object and is idempotent when it is already gone', async () => {
      const key = 'tracks/u/t/original.mp3';
      await storage.write({ key, body: Buffer.from('xyz') });
      await storage.delete(key);
      expect(await storage.stat(key)).toBeNull();
      await expect(storage.delete(key)).resolves.toBeUndefined();
      await expect(storage.delete('tracks/u/t/never-existed.mp3')).resolves.toBeUndefined();
    });

    it('leaves no readable object behind when a streamed write fails mid-flight', async () => {
      const key = 'tracks/u/t/original.mp3';
      await expect(storage.write({ key, body: failingBody() })).rejects.toThrow();
      expect(await storage.stat(key)).toBeNull();
      await expect(storage.readStream(key)).rejects.toThrow();
    });

    it('keeps a previously stored object readable when overwriting it fails mid-flight', async () => {
      const key = 'tracks/u/t/original.mp3';
      await storage.write({ key, body: Buffer.from('good bytes') });
      await expect(storage.write({ key, body: failingBody() })).rejects.toThrow();
      const read = await collect(await storage.readStream(key));
      expect(read.toString()).toBe('good bytes');
    });

    it('combines read and stat in one call: full and ranged reads, total size, missing key', async () => {
      const key = 'tracks/u/t/original.mp3';
      const body = Buffer.from('0123456789');
      await storage.write({ key, body, mimeType: 'audio/mpeg' });

      const full = await storage.readStreamWithStat!(key);
      expect(full).not.toBeNull();
      expect((await collect(full!.stream)).toString()).toBe('0123456789');
      expect(full!.stat.byteSize).toBe(10);
      expect(full!.stat.updatedAt).toBeInstanceOf(Date);

      // The stat always describes the WHOLE object, never the range slice.
      const ranged = await storage.readStreamWithStat!(key, { start: 2, end: 5 });
      expect((await collect(ranged!.stream)).toString()).toBe('2345');
      expect(ranged!.stat.byteSize).toBe(10);

      const toEnd = await storage.readStreamWithStat!(key, { start: 7 });
      expect((await collect(toEnd!.stream)).toString()).toBe('789');
      expect(toEnd!.stat.byteSize).toBe(10);

      // A start at/past the object size yields an empty stream (readStream parity).
      const pastEnd = await storage.readStreamWithStat!(key, { start: 10 });
      expect(await collect(pastEnd!.stream)).toHaveLength(0);
      expect(pastEnd!.stat.byteSize).toBe(10);

      expect(await storage.readStreamWithStat!('tracks/u/t/missing.mp3')).toBeNull();
      expect(await storage.readStreamWithStat!('tracks/u/t/missing.mp3', { start: 3 })).toBeNull();
    });

    it('builds an app-routed read URL that carries the key, percent-encoded per segment', async () => {
      const url = await storage.createReadUrl('tracks/user-1/track-9/original.mp3');
      expect(url).toBe('/api/files/tracks/user-1/track-9/original.mp3');

      const encoded = await storage.createReadUrl('covers/uploaded/u/a b#c?.png');
      expect(encoded).toBe('/api/files/covers/uploaded/u/a%20b%23c%3F.png');
    });

    it("reports the volume's free space where there is a volume", async (context) => {
      // An optional capability: local-fs answers with real free space, object
      // storage does not implement it at all (a caller reads that absence as "no
      // volume to exhaust"). Skipping rather than returning keeps the adapter
      // that has no volume visible as a skip instead of a silent pass.
      if (!storage.freeBytes) {
        context.skip();
        return;
      }
      const free = await storage.freeBytes();
      expect(Number.isFinite(free)).toBe(true);
      // A temp dir was just written to, so the volume backing it cannot be full.
      expect(free).toBeGreaterThan(0);
    });

    it('refuses every operation for a traversal key', async () => {
      for (const key of ['../escape.mp3', 'tracks/../../escape.mp3', '/etc/passwd', '~/escape']) {
        await expect(storage.write({ key, body: Buffer.from('x') })).rejects.toThrow(
          StorageKeyError,
        );
        await expect(storage.readStream(key)).rejects.toThrow(StorageKeyError);
        await expect(storage.readStreamWithStat!(key)).rejects.toThrow(StorageKeyError);
        await expect(storage.stat(key)).rejects.toThrow(StorageKeyError);
        await expect(storage.delete(key)).rejects.toThrow(StorageKeyError);
        await expect(storage.createReadUrl(key)).rejects.toThrow(StorageKeyError);
      }
    });
  });
}
