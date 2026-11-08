// The stored-MP3 side of ID3 tagging: measure a file's leading tag without
// pulling the file into memory (two small ranged reads), and compose
// `new tag ++ existing audio body` as a stream. Both the worker's retag job and
// the download routes go through here, so "where the audio body starts" and
// "how long the result is" have exactly one definition.

import { Readable } from 'node:stream';
import { id3v2TagLength, ID3_HEADER_SIZE, readId3Tags } from '@liedmotif/shared';
import { readAllBytes, type StorageProvider } from './index';

/** The file's first `length` bytes, as one ranged read. */
async function readPrefix(
  storage: Pick<StorageProvider, 'readStream'>,
  key: string,
  length: number,
): Promise<Uint8Array> {
  return readAllBytes(await storage.readStream(key, { start: 0, end: length - 1 }));
}

/**
 * The embed writer puts TXXX frames before the (large) APIC artwork frame, so
 * a marker probe only ever needs the tag's head — embedded 1024 px art makes
 * the full leading tag 150–300 KB, of which the probe cares about a few hundred
 * bytes.
 */
const USER_TEXT_PROBE_PREFIX_BYTES = 64 * 1024;

/** What a stored MP3's leading tag says, alongside the object's total size. */
export interface StoredId3State {
  /** Total object size, from the same measurement as `tagLength`. */
  byteSize: number;
  /** Byte length of the leading ID3v2 tag; 0 when the file carries none. */
  tagLength: number;
  /** The requested TXXX frame's value; null when the tag is absent, unreadable
   *  by the parser, or carries no such frame. */
  marker: string | null;
}

/**
 * Measure a stored MP3: its size, its leading tag's length, and that tag's
 * `description` TXXX frame — touching at most 64 KB of the tag. Only a miss in a
 * LONGER tag re-reads it in full, since a tag written by anything other than our
 * embed writer may order its frames differently.
 *
 * Null when the object does not exist. THROWS on storage I/O errors: a caller
 * about to rewrite or re-compose the file from `tagLength` must never act on a
 * mis-sized measurement.
 */
export async function measureStoredId3(
  storage: Pick<StorageProvider, 'readStream' | 'stat'>,
  key: string,
  description: string,
): Promise<StoredId3State | null> {
  const stat = await storage.stat(key);
  if (!stat) return null;
  const marker = (bytes: Uint8Array) => readId3Tags(bytes)?.userText[description] ?? null;
  const tagLength = id3v2TagLength(await readPrefix(storage, key, ID3_HEADER_SIZE));
  if (tagLength === 0) return { byteSize: stat.byteSize, tagLength: 0, marker: null };

  const prefixLength = Math.min(tagLength, USER_TEXT_PROBE_PREFIX_BYTES);
  let found = marker(await readPrefix(storage, key, prefixLength));
  if (found === null && prefixLength < tagLength) {
    found = marker(await readPrefix(storage, key, tagLength));
  }
  return { byteSize: stat.byteSize, tagLength, marker: found };
}

/**
 * `tag ++ the audio body that follows the file's existing leading tag`, as a
 * stream and its exact byte length. The body read is bounded by the measured
 * size, so the stream can never outrun the length reported here; a (corrupt)
 * leading tag claiming the whole file leaves no body at all, and the ranged read
 * is skipped rather than asking an adapter for bytes past EOF.
 */
export function composeId3Rewrite(
  storage: Pick<StorageProvider, 'readStream'>,
  key: string,
  tag: Uint8Array,
  stored: Pick<StoredId3State, 'byteSize' | 'tagLength'>,
): { stream: Readable; byteSize: number } {
  const bodyLength = Math.max(stored.byteSize - stored.tagLength, 0);
  const stream = Readable.from(
    (async function* () {
      yield tag;
      if (bodyLength > 0) {
        yield* await storage.readStream(key, {
          start: stored.tagLength,
          end: stored.byteSize - 1,
        });
      }
    })(),
  );
  return { stream, byteSize: tag.length + bodyLength };
}
