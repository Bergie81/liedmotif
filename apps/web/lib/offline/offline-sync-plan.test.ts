import { describe, expect, it } from 'vitest';
import type { OfflineManifestTrack } from '@liedmotif/shared';
import {
  LOUNGE_OFFLINE_EXPIRY_MS,
  offlineCopyPlayable,
  planOfflineSync,
  type PlannedMark,
  type StoredTrack,
} from './offline-sync-plan';

const MB = 1_000_000;

function track(
  trackId: string,
  byteSize: number | null = 4 * MB,
  version = 'v1',
  fromLounge = false,
) {
  return {
    trackId,
    byteSize,
    version,
    title: trackId,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 180,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge,
  } satisfies OfflineManifestTrack;
}

function mark(key: string, markedAt: number, tracks: OfflineManifestTrack[]): PlannedMark {
  return { key, markedAt, manifest: { name: key, tracks, leftOutTrackCount: 0 } };
}

function stored(trackId: string, bytes = 4 * MB, version = 'v1'): StoredTrack {
  return { trackId, bytes, version, coverImageId: null, coverBytes: 0 };
}

/** A Track whose cover the device stores beside its audio. */
function covered(trackId: string, byteSize: number, coverByteSize: number, version = 'v1') {
  return {
    ...track(trackId, byteSize, version),
    coverImageId: `cover-${trackId}`,
    coverByteSize,
  } satisfies OfflineManifestTrack;
}

/** A stored copy holding `coverBytes` of the cover `coverImageId` (0 when it failed to arrive). */
function storedWithCover(
  trackId: string,
  audioBytes: number,
  coverImageId: string,
  coverBytes: number,
  version = 'v1',
): StoredTrack {
  return { trackId, bytes: audioBytes + coverBytes, version, coverImageId, coverBytes };
}

const ids = (tracks: { trackId: string }[]) => tracks.map((entry) => entry.trackId);

describe('planOfflineSync', () => {
  it('downloads what the device is missing and deletes what no mark lists any more', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [track('kept'), track('added')])],
      stored: [stored('kept'), stored('removed')],
      capBytes: 100 * MB,
    });

    expect(ids(plan.downloads)).toEqual(['added']);
    expect(plan.deletions).toEqual(['removed']);
    expect(plan.refreshes).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('stores a Track in two marks once and keeps it while either mark lists it', () => {
    const both = planOfflineSync({
      marks: [mark('playlist:a', 1, [track('shared')]), mark('playlist:b', 2, [track('shared')])],
      stored: [],
      capBytes: 100 * MB,
    });
    expect(ids(both.downloads)).toEqual(['shared']);

    const oneLeft = planOfflineSync({
      marks: [mark('playlist:b', 2, [track('shared')])],
      stored: [stored('shared')],
      capBytes: 100 * MB,
    });
    expect(oneLeft.deletions).toEqual([]);
    expect(oneLeft.downloads).toEqual([]);
  });

  it('refuses a mark whose missing Tracks would go over the cap, and plans none of them', () => {
    const plan = planOfflineSync({
      marks: [
        mark('playlist:old', 1, [track('o1', 6 * MB), track('o2', 6 * MB)]),
        mark('playlist:new', 2, [track('n1', 5 * MB), track('n2', 5 * MB)]),
      ],
      stored: [stored('o1', 6 * MB)],
      capBytes: 20 * MB,
    });

    expect(ids(plan.downloads)).toEqual(['o2']);
    expect(plan.refusals).toEqual([
      { key: 'playlist:new', neededBytes: 10 * MB, freeBytes: 8 * MB },
    ]);
  });

  it('never refuses a mark that needs nothing new, even with the device past the cap', () => {
    // A device can sit past its cap after the cap's own accounting changed, or
    // when a server's sizes were unknown (counted as 0); it keeps what it holds.
    const plan = planOfflineSync({
      marks: [
        mark('playlist:held', 1, [track('h1', 5 * MB), track('h2', 5 * MB)]),
        mark('playlist:subset', 2, [track('h1', 5 * MB)]),
      ],
      stored: [stored('h1', 5.2 * MB), stored('h2', 5.2 * MB)],
      capBytes: 10 * MB,
    });

    expect(plan.downloads).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('counts the space deletions free before deciding what fits', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [track('next', 8 * MB)])],
      stored: [stored('gone', 8 * MB)],
      capBytes: 10 * MB,
    });

    expect(plan.deletions).toEqual(['gone']);
    expect(ids(plan.downloads)).toEqual(['next']);
    expect(plan.refusals).toEqual([]);
  });

  it('resumes a partial download: only the Tracks not yet stored are fetched and counted', () => {
    const plan = planOfflineSync({
      marks: [
        mark('playlist:a', 1, [track('t1', 4 * MB), track('t2', 4 * MB), track('t3', 4 * MB)]),
      ],
      stored: [stored('t1', 4 * MB), stored('t2', 4 * MB)],
      capBytes: 12 * MB,
    });

    expect(ids(plan.downloads)).toEqual(['t3']);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses a mark whose covers push it over the cap', () => {
    // Cap 20 MB, 10 MB held: 8 MB of audio fits, 8 MB of audio and 3 MB of covers does not.
    const plan = planOfflineSync({
      marks: [
        mark('playlist:held', 1, [track('h1', 10 * MB)]),
        mark('playlist:new', 2, [covered('n1', 4 * MB, 1.5 * MB), covered('n2', 4 * MB, 1.5 * MB)]),
      ],
      stored: [stored('h1', 10 * MB)],
      capBytes: 20 * MB,
    });

    expect(plan.downloads).toEqual([]);
    expect(plan.refusals).toEqual([
      { key: 'playlist:new', neededBytes: 11 * MB, freeBytes: 10 * MB },
    ]);
  });

  it('admits a mark that fits with its covers', () => {
    const plan = planOfflineSync({
      marks: [
        mark('playlist:held', 1, [track('h1', 10 * MB)]),
        mark('playlist:new', 2, [covered('n1', 4 * MB, 1 * MB), covered('n2', 4 * MB, 1 * MB)]),
      ],
      stored: [stored('h1', 10 * MB)],
      capBytes: 20 * MB,
    });

    expect(ids(plan.downloads)).toEqual(['n1', 'n2']);
    expect(plan.refusals).toEqual([]);
  });

  it('counts each Track once with its cover once, also when Tracks share a cover', () => {
    // Two Tracks share one Session cover, yet the device stores a cover per Track.
    const sessionCover = (trackId: string) => ({
      ...covered(trackId, 4 * MB, 1 * MB),
      coverImageId: 'session-cover',
    });
    const fits = planOfflineSync({
      marks: [
        mark('playlist:a', 1, [sessionCover('t1'), sessionCover('t2')]),
        mark('playlist:b', 2, [sessionCover('t1')]),
      ],
      stored: [],
      capBytes: 10 * MB,
    });
    expect(ids(fits.downloads)).toEqual(['t1', 't2']);
    expect(fits.refusals).toEqual([]);

    const tooBig = planOfflineSync({
      marks: [mark('playlist:a', 1, [sessionCover('t1'), sessionCover('t2')])],
      stored: [],
      capBytes: 10 * MB - 1,
    });
    expect(tooBig.refusals).toEqual([
      { key: 'playlist:a', neededBytes: 10 * MB, freeBytes: 10 * MB - 1 },
    ]);
  });

  it('counts no cover bytes for a manifest an older app stored without cover sizes', () => {
    const { coverByteSize: _absent, ...older } = covered('old', 4 * MB, 3 * MB);
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [older])],
      stored: [],
      capBytes: 4 * MB,
    });

    expect(ids(plan.downloads)).toEqual(['old']);
    expect(plan.refusals).toEqual([]);
  });

  it('fetches a stored copy’s missing cover when it fits', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [covered('t', 4 * MB, 2 * MB)])],
      stored: [storedWithCover('t', 4 * MB, 'cover-t', 0)],
      capBytes: 6 * MB,
    });

    expect(plan.refreshes).toEqual([{ track: covered('t', 4 * MB, 2 * MB), withCover: true }]);
  });

  it('leaves a missing cover for a later sync when it would go over the cap, keeping the audio', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [covered('t', 4 * MB, 2 * MB)])],
      stored: [storedWithCover('t', 4 * MB, 'cover-t', 0)],
      capBytes: 6 * MB - 1,
    });

    expect(plan.refreshes).toEqual([]);
    expect(plan.deletions).toEqual([]);
    expect(plan.downloads).toEqual([]);
  });

  it('refreshes a copy whose cover changed with the new cover only when its size fits', () => {
    const changed = { ...covered('t', 4 * MB, 3 * MB, 'v2'), coverImageId: 'cover-new' };
    const held = storedWithCover('t', 4 * MB, 'cover-old', 1 * MB);

    const fits = planOfflineSync({
      marks: [mark('playlist:a', 1, [changed])],
      stored: [held],
      capBytes: 7 * MB,
    });
    expect(fits.refreshes).toEqual([{ track: changed, withCover: true }]);

    const over = planOfflineSync({
      marks: [mark('playlist:a', 1, [changed])],
      stored: [held],
      capBytes: 7 * MB - 1,
    });
    expect(over.refreshes).toEqual([{ track: changed, withCover: false }]);
  });

  it('keeps a held cover on a metadata refresh with the device past the cap', () => {
    const renamed = covered('t', 4 * MB, 2 * MB, 'v2');
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [renamed])],
      stored: [storedWithCover('t', 4 * MB, 'cover-t', 2 * MB)],
      capBytes: 5 * MB,
    });

    expect(plan.refreshes).toEqual([{ track: renamed, withCover: true }]);
  });

  it('takes a changed cover that is no larger than the held one, also past the cap', () => {
    const changed = { ...covered('t', 4 * MB, 1 * MB, 'v2'), coverImageId: 'cover-new' };
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [changed])],
      stored: [storedWithCover('t', 4 * MB, 'cover-old', 2 * MB)],
      capBytes: 4.5 * MB,
    });

    expect(plan.refreshes).toEqual([{ track: changed, withCover: true }]);
  });

  it('gives a mark’s downloads room before a stored copy’s cover', () => {
    const plan = planOfflineSync({
      marks: [
        mark('playlist:held', 1, [covered('h', 4 * MB, 2 * MB)]),
        mark('playlist:new', 2, [track('n', 2 * MB)]),
      ],
      stored: [storedWithCover('h', 4 * MB, 'cover-h', 0)],
      capBytes: 6 * MB,
    });

    expect(ids(plan.downloads)).toEqual(['n']);
    expect(plan.refreshes).toEqual([]);
  });

  it('refreshes a stored copy whose metadata version moved, without downloading it again', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [track('renamed', 4 * MB, 'v2'), track('same')])],
      stored: [stored('renamed', 4 * MB, 'v1'), stored('same')],
      capBytes: 100 * MB,
    });

    expect(plan.refreshes).toEqual([{ track: track('renamed', 4 * MB, 'v2'), withCover: true }]);
    expect(plan.downloads).toEqual([]);
  });

  // Revoking a share reaches the device on its next sync: the server stops
  // listing the Track in every manifest — the Lounge Playlist's (or the whole
  // mark, once the Playlist leaves the Visitor's Lounge) and the Visitor's own
  // Playlists' Shared references alike.
  it('purges a revoked Lounge Track from the device while keeping what the marks still list', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:own', 1, [track('mine'), track('still-shared', 4 * MB, 'v1', true)])],
      stored: [stored('mine'), stored('still-shared'), stored('revoked')],
      capBytes: 100 * MB,
    });

    expect(plan.deletions).toEqual(['revoked']);
    expect(plan.downloads).toEqual([]);
  });

  it('follows a Session growing between syncs: what landed since is fetched in play order, a Disliked Track dropped', () => {
    const first = planOfflineSync({
      marks: [mark('session:s', 1, [track('s1'), track('s2')])],
      stored: [],
      capBytes: 100 * MB,
    });
    expect(ids(first.downloads)).toEqual(['s1', 's2']);

    const grown = planOfflineSync({
      marks: [mark('session:s', 1, [track('s1'), track('s3'), track('s4')])],
      stored: [stored('s1'), stored('s2')],
      capBytes: 100 * MB,
    });
    expect(ids(grown.downloads)).toEqual(['s3', 's4']);
    expect(grown.deletions).toEqual(['s2']);
    expect(grown.refusals).toEqual([]);
  });
});

describe('offlineCopyPlayable', () => {
  const syncedAt = Date.UTC(2026, 10, 1);
  const lounge = { fromLounge: true };

  it('plays a Lounge copy until 7 days pass without a successful sync, and not from then on', () => {
    expect(LOUNGE_OFFLINE_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(offlineCopyPlayable(lounge, syncedAt, syncedAt + LOUNGE_OFFLINE_EXPIRY_MS - 1)).toBe(
      true,
    );
    expect(offlineCopyPlayable(lounge, syncedAt, syncedAt + LOUNGE_OFFLINE_EXPIRY_MS)).toBe(false);
  });

  it('never plays a Lounge copy on a device that has not synced successfully', () => {
    expect(offlineCopyPlayable(lounge, null, syncedAt)).toBe(false);
  });

  it('always plays the listener’s own Tracks, however long ago the last sync was', () => {
    expect(offlineCopyPlayable({ fromLounge: false }, null, syncedAt)).toBe(true);
    expect(offlineCopyPlayable({ fromLounge: false }, syncedAt, syncedAt + 365 * 86_400_000)).toBe(
      true,
    );
  });
});
