// Streaming zip assembly for the session/playlist download routes. STORE mode
// only — MP3 is already compressed, so the zip is I/O-bound copying, never a
// CPU cost. A long download holds one file handle and at most one composed tag
// in memory: entries take turns (see `lazyEntryStream`), memory stays bounded by
// stream highwater marks, and client backpressure propagates into the reads.

import { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import type { DownloadableTrack } from '@liedmotif/db';
import { createLogger, Semaphore, SemaphoreBusyError } from '@liedmotif/shared';
import {
  openTrackDownload,
  planTrackDownloads,
  trackDownloadFileName,
  type TrackDownload,
  type TrackDownloadDeps,
} from './track-downloads';
import { webStreamFromReadable } from './web-stream';

const logger = createLogger({ name: 'zip-download' });

/** `NNN-<title-slug>-<id8>.<ext>`: a three-digit play-order prefix over the
 *  delivered entries — unique per zip, and file listings sort in play order.
 *  Beyond 999 entries the prefix simply grows a digit. */
export function zipEntryName(index: number, track: DownloadableTrack): string {
  return `${String(index + 1).padStart(3, '0')}-${trackDownloadFileName(track)}`;
}

/** One entry's place in the queue: it opens its bytes only once the entry before
 *  it is done, and hands the turn on however its own streaming ended. */
interface EntryTurn {
  /** Settles when the entry before this one has finished streaming. */
  after: Promise<void>;
  /** Lets the entry after this one open. */
  done: () => void;
  /** True once the client tore the response down. */
  cancelled: () => boolean;
  /** Hands over the opened stored stream, so a cancel can close it. */
  opened: (stream: Readable) => void;
}

/** A source that opens its bytes only when its turn comes. `archive.append`
 *  pipes its source through a PassThrough the moment it is appended, so a whole
 *  playlist appended up front would open every track's stored object — and
 *  render every cover — at once. Taking turns keeps that to one handle at a
 *  time, and the entries behind a cancelled response never open at all. */
function lazyEntryStream(
  deps: TrackDownloadDeps,
  download: TrackDownload,
  turn: EntryTurn,
): Readable {
  return Readable.from(
    (async function* () {
      await turn.after;
      if (turn.cancelled()) return;
      try {
        const { stream } = await openTrackDownload(deps, download);
        if (turn.cancelled()) {
          stream.destroy();
          return;
        }
        turn.opened(stream);
        yield* stream;
      } catch (err) {
        // A zip that has started streaming can no longer change its status code,
        // so an entry whose bytes went away between the plan and its turn is
        // delivered short rather than taking the whole download down with it.
        // Erroring here would not even reach the client: archiver pipes this
        // source into a PassThrough that forwards no error, so the failure would
        // surface as an uncaught exception and a download that never ends.
        logger.warn('zip entry cut short: its stored bytes could not be read', {
          trackId: download.track.trackId,
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      } finally {
        turn.done();
      }
    })(),
  );
}

/** The planned downloads as one streaming zip, in the given order. */
export function createTracksZipStream(
  deps: TrackDownloadDeps,
  downloads: readonly TrackDownload[],
): ReadableStream<Uint8Array> {
  const archive = new ZipArchive({ store: true });
  archive.on('error', (err) => {
    // Client cancel or a mid-stream read failure — the response stream is
    // already dead; nothing to do beyond noting it.
    logger.warn('zip stream ended early', { errorName: err.name });
  });
  let cancelled = false;
  let inFlight: Readable | null = null;
  const opened = (stream: Readable) => {
    inFlight = stream;
  };
  // The chain of turns: the first entry has nothing to wait for.
  let previousEntry = Promise.resolve();
  for (const [index, download] of downloads.entries()) {
    const after = previousEntry;
    let done!: () => void;
    previousEntry = new Promise<void>((resolve) => {
      done = resolve;
    });
    archive.append(
      lazyEntryStream(deps, download, { after, done, cancelled: () => cancelled, opened }),
      { name: zipEntryName(index, download.track) },
    );
  }
  // Never awaited: finalize resolves only once the (unconsumed) output drains.
  void archive.finalize().catch(() => undefined);

  // Destroying the wrapped Readable does not reach archiver's internal queue;
  // only `abort()` kills it and detaches the module pipes, so the entry in
  // flight stops being drained instead of running out its source into a stream
  // nobody will read. Neither closes that entry's stored stream: unread, it
  // would hold its file handle (or S3 socket) open for good.
  return webStreamFromReadable(archive, () => {
    cancelled = true;
    archive.abort();
    inFlight?.destroy();
  });
}

/**
 * Concurrent download PLANS. Streaming an archive is lazy and bounded (one
 * entry, one handle), but planning one is a fan-out of storage stats and tag
 * reads over every track — a 400-track playlist times a handful of clients is
 * the burst worth bounding. Short work, so a caller waits briefly rather than
 * being refused on the first collision.
 */
const planSlots = new Semaphore(2, { maxWaiting: 4, waitTimeoutMs: 10_000 });

/**
 * The zip routes' whole job: an attachment streaming the tracks' current-truth
 * finals in the given order, or null when none of them has bytes left to deliver
 * (the route then 404s). No Content-Length — the zip is produced as it streams
 * (Caddy passes chunked responses through unbuffered).
 */
export async function tracksZipResponse(
  deps: TrackDownloadDeps,
  tracks: DownloadableTrack[],
  fileName: string,
): Promise<Response | null> {
  let downloads: TrackDownload[];
  try {
    downloads = await planSlots.run(() => planTrackDownloads(deps, tracks));
  } catch (err) {
    // A byte route carries no envelope, so saturation answers in the plain shape
    // its 404 already uses.
    if (err instanceof SemaphoreBusyError) {
      return new Response('Busy, try again shortly', {
        status: 503,
        headers: { 'Retry-After': '10' },
      });
    }
    throw err;
  }
  if (downloads.length === 0) return null;
  return new Response(createTracksZipStream(deps, downloads), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
