import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { StorageProvider } from '@liedmotif/storage';
import type { TrackDownload, TrackDownloadDeps } from './track-downloads';
import { createTracksZipStream } from './zip-download';

// A zip entry costs a storage handle (and, for a stale file, a rendered cover),
// so the archive must open exactly the entry it is writing: appending the whole
// list up front opens every track at once, and a client that cancels after entry
// 3 must not pay for the other 97.

/** A parked stream: one byte, then it waits for the test to let it finish. */
interface Held {
  release: () => void;
}

interface Stub {
  deps: TrackDownloadDeps;
  opens: string[];
  held: Held[];
  /** Every stored stream handed out, in open order. */
  sources: Readable[];
}

/**
 * Storage whose reads record their key and, when `hold` is set, park until the
 * test releases them — so "which entries have opened" is a fact about the
 * archive's ordering rather than a race with its buffering.
 */
function stubDeps(options: { hold?: boolean; failAt?: number } = {}): Stub {
  const opens: string[] = [];
  const held: Held[] = [];
  const sources: Readable[] = [];
  const storage = {
    async readStream(key: string): Promise<Readable> {
      const index = opens.length;
      opens.push(key);
      if (index === options.failAt) throw new Error('stored bytes are gone');
      const parked = new Promise<void>((resolve) => held.push({ release: resolve }));
      const source = Readable.from(
        (async function* () {
          yield Buffer.from(`audio-${index}`);
          if (options.hold) await parked;
        })(),
      );
      sources.push(source);
      return source;
    },
  } as unknown as StorageProvider;
  return {
    // A download with no tags streams the stored bytes untouched, so neither the
    // database nor the album-art renderer is reachable from this path.
    deps: { db: undefined, storage, albumArt: undefined } as unknown as TrackDownloadDeps,
    opens,
    held,
    sources,
  };
}

function downloads(count: number): TrackDownload[] {
  return Array.from({ length: count }, (_, index) => ({
    track: {
      trackId: `00000000-0000-4000-8000-00000000000${index}`,
      title: `Track ${index}`,
      storageKey: `tracks/track-${index}.mp3`,
      mimeType: 'audio/mpeg',
      byteSize: 8,
    },
    storedByteSize: 8,
    tags: null,
  }));
}

/** Let the archive's queue and its piped sources make all the progress they can. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
  }
}

describe('createTracksZipStream', () => {
  it('opens one entry at a time, and none of the ones behind a cancelled response', async () => {
    const { deps, opens, held, sources } = stubDeps({ hold: true });
    const stream = createTracksZipStream(deps, downloads(5));

    await settle();
    expect(opens).toEqual(['tracks/track-0.mp3']);

    await stream.cancel();
    await settle();
    // The entry in flight holds a file handle (or an S3 socket): a cancel must
    // close it, not leave it parked until the process exits.
    expect(sources[0]?.destroyed).toBe(true);
    // Releasing the entry that was in flight must not hand the turn on.
    held.forEach((entry) => entry.release());
    await settle();
    expect(opens).toEqual(['tracks/track-0.mp3']);
  });

  it('delivers every entry when the whole archive is read', async () => {
    const { deps, opens } = stubDeps();
    const bytes = await readAll(createTracksZipStream(deps, downloads(3)));

    expect(opens).toEqual(['tracks/track-0.mp3', 'tracks/track-1.mp3', 'tracks/track-2.mp3']);
    // Local header, every entry's name and stored payload, and the end-of-central
    // -directory record: a complete archive, not a truncated one.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    for (let index = 0; index < 3; index += 1) {
      expect(bytes.includes(`00${index + 1}-track-${index}-00000000.mp3`)).toBe(true);
      expect(bytes.includes(`audio-${index}`)).toBe(true);
    }
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
  });

  it('hands the turn on when an entry cannot be opened, so one gone file cannot stall the download', async () => {
    const { deps, opens } = stubDeps({ failAt: 1 });
    await readAll(createTracksZipStream(deps, downloads(3)));

    expect(opens).toEqual(['tracks/track-0.mp3', 'tracks/track-1.mp3', 'tracks/track-2.mp3']);
  });
});
