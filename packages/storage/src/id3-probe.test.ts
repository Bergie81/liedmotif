import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { embedId3Tags, stripId3v2 } from '@liedmotif/shared';
import { composeId3Rewrite, measureStoredId3 } from './id3-probe';
import { readAllBytes } from './index';

const MARKER = 'Liedmotif';

/** In-memory storage that records every requested range. */
function fakeStorage(bytes: Uint8Array) {
  const reads: Array<{ start: number; end: number } | null> = [];
  return {
    reads,
    storage: {
      stat: async (key: string) => ({
        key,
        byteSize: bytes.length,
        updatedAt: new Date(0),
      }),
      readStream: async (_key: string, range?: { start: number; end: number }) => {
        reads.push(range ?? null);
        const slice = range ? bytes.subarray(range.start, range.end + 1) : bytes;
        return Readable.from([Buffer.from(slice)]);
      },
    },
  };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe('measureStoredId3', () => {
  it('finds the marker within the 64 KB prefix without reading the full tag', async () => {
    // Embedded album art makes the leading tag far larger than the prefix; the
    // writer puts TXXX before APIC, so the probe must stop at the prefix.
    const tagged = embedId3Tags(AUDIO, {
      userText: { [MARKER]: 'v3:test' },
      artwork: { bytes: new Uint8Array(200 * 1024).fill(7), mediaType: 'image/jpeg' },
    });
    const { reads, storage } = fakeStorage(tagged);

    await expect(measureStoredId3(storage, 'k', MARKER)).resolves.toEqual({
      byteSize: tagged.length,
      tagLength: tagged.length - AUDIO.length,
      marker: 'v3:test',
    });
    expect(reads).toHaveLength(2);
    expect(reads[1]!.end - reads[1]!.start + 1).toBeLessThanOrEqual(64 * 1024);
  });

  it('re-reads the full tag when the marker sits beyond the prefix', async () => {
    // A giant USLT lyric lands before TXXX, pushing the marker past 64 KB.
    const tagged = embedId3Tags(AUDIO, {
      lyrics: 'la '.repeat(30_000),
      userText: { [MARKER]: 'v3:test' },
    });
    const { reads, storage } = fakeStorage(tagged);

    await expect(measureStoredId3(storage, 'k', MARKER)).resolves.toMatchObject({
      marker: 'v3:test',
    });
    expect(reads).toHaveLength(3);
  });

  it('reports no marker for an untagged file and for a tag without the frame', async () => {
    await expect(measureStoredId3(fakeStorage(AUDIO).storage, 'k', MARKER)).resolves.toEqual({
      byteSize: AUDIO.length,
      tagLength: 0,
      marker: null,
    });

    const other = embedId3Tags(AUDIO, { title: 'No marker here' });
    await expect(measureStoredId3(fakeStorage(other).storage, 'k', MARKER)).resolves.toEqual({
      byteSize: other.length,
      tagLength: other.length - AUDIO.length,
      marker: null,
    });
  });

  it('answers null for an object that is not there', async () => {
    const storage = { ...fakeStorage(AUDIO).storage, stat: async () => null };
    await expect(measureStoredId3(storage, 'k', MARKER)).resolves.toBeNull();
  });

  it('throws when the read fails: a mis-sized tag must never be acted on', async () => {
    const storage = {
      ...fakeStorage(AUDIO).storage,
      readStream: async () => {
        throw new Error('storage down');
      },
    };
    await expect(measureStoredId3(storage, 'k', MARKER)).rejects.toThrow('storage down');
  });
});

describe('composeId3Rewrite', () => {
  it('replaces the leading tag, keeping the audio body byte-for-byte', async () => {
    const tagged = embedId3Tags(AUDIO, { title: 'Old' });
    const { reads, storage } = fakeStorage(tagged);
    const stored = (await measureStoredId3(storage, 'k', MARKER))!;
    reads.length = 0;

    const fresh = embedId3Tags(new Uint8Array(), { title: 'New' });
    const composed = composeId3Rewrite(storage, 'k', fresh, stored);
    const bytes = await readAllBytes(composed.stream);
    expect(bytes.subarray(0, fresh.length)).toEqual(fresh);
    expect(stripId3v2(bytes)).toEqual(AUDIO);
    expect(composed.byteSize).toBe(bytes.length);
    // The body read is bounded, so the stream can never outrun `byteSize`.
    expect(reads).toEqual([{ start: stored.tagLength, end: tagged.length - 1 }]);
  });

  it('emits the tag alone when the stored tag claims the whole file', async () => {
    const fresh = embedId3Tags(new Uint8Array(), { title: 'New' });
    const { reads, storage } = fakeStorage(AUDIO);
    const composed = composeId3Rewrite(storage, 'k', fresh, { byteSize: 4, tagLength: 4 });

    expect(await readAllBytes(composed.stream)).toEqual(fresh);
    expect(composed.byteSize).toBe(fresh.length);
    expect(reads).toEqual([]);
  });
});
