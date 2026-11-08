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
  return { trackId, bytes, version, coverMissing: false };
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

  it('refreshes a stored copy whose metadata version moved, without downloading it again', () => {
    const plan = planOfflineSync({
      marks: [mark('playlist:a', 1, [track('renamed', 4 * MB, 'v2'), track('same')])],
      stored: [stored('renamed', 4 * MB, 'v1'), stored('same')],
      capBytes: 100 * MB,
    });

    expect(ids(plan.refreshes)).toEqual(['renamed']);
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
