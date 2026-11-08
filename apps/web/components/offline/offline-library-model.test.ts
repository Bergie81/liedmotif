import { describe, expect, it } from 'vitest';
import type { OfflineManifestTrack, TrackDetails, TrackLyrics } from '@liedmotif/shared';
import type { OfflineMark, OfflineTrackCopy } from '@/lib/offline/offline-store';
import { LOUNGE_OFFLINE_EXPIRY_MS } from '@/lib/offline/offline-sync-plan';
import {
  offlineCollectionNoun,
  offlineCollections,
  offlinePlayableTracks,
  offlineTrackMedia,
} from './offline-library-model';

// What the Offline Library makes of the device's offline store: the offline
// Playlists it lists, the Track list it hands the Player, and the cover,
// lyrics and Track Data the Player shows — all read from the device.

function entry(
  trackId: string,
  overrides: Partial<OfflineManifestTrack> = {},
): OfflineManifestTrack {
  return {
    trackId,
    byteSize: 1000,
    version: 'v1',
    title: `Title ${trackId}`,
    artist: `Artist ${trackId}`,
    originSessionTitle: `Session ${trackId}`,
    durationSeconds: 180,
    coverImageId: null,
    genreTags: ['house'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge: false,
    ...overrides,
  };
}

const DETAILS = { title: 'Title t1', artistName: 'Thomas' } as TrackDetails;
const LYRICS: TrackLyrics = {
  state: 'ready',
  lines: [{ kind: 'line', text: 'hello', timeSeconds: 1 }],
  synced: true,
  settled: false,
};

function copy(
  track: OfflineManifestTrack,
  extra: Partial<OfflineTrackCopy> = {},
): OfflineTrackCopy {
  return {
    trackId: track.trackId,
    version: track.version,
    track,
    details: DETAILS,
    lyrics: null,
    audioBytes: 1000,
    coverBytes: 0,
    ...extra,
  };
}

function mark(id: string, name: string, tracks: OfflineManifestTrack[]): OfflineMark {
  return {
    key: `playlist:${id}`,
    kind: 'playlist',
    id,
    markedAt: 1,
    syncedAt: 2,
    manifest: { name, tracks, leftOutTrackCount: 0 },
  };
}

describe('offlineCollections', () => {
  it('lists each offline Playlist by name with the Tracks this device holds, in play order', () => {
    const [t1, t2, t3] = [entry('t1'), entry('t2'), entry('t3')];
    const collections = offlineCollections(
      [mark('p2', 'Road trip', [t2, t3, t1]), mark('p1', 'Focus', [t1])],
      // t3 has not finished fetching yet.
      [copy(t1), copy(t2)],
      2,
      3,
    );

    expect(collections.map((c) => [c.key, c.name, c.tracks.map((t) => t.trackId)])).toEqual([
      ['playlist:p1', 'Focus', ['t1']],
      ['playlist:p2', 'Road trip', ['t2', 't1']],
    ]);
  });

  it('holds back a Lounge Track no sync has confirmed for a week, and counts it as expired', () => {
    const own = entry('own');
    const lounge = entry('lounge', { fromLounge: true });
    const marks = [mark('p1', 'Mixed', [lounge, own]), mark('p2', 'Their mix', [lounge])];
    const copies = [copy(own), copy(lounge)];
    const syncedAt = 1_000;
    const view = (now: number) =>
      offlineCollections(marks, copies, syncedAt, now).map((c) => [
        c.name,
        c.tracks.map((t) => t.trackId),
        c.expiredCount,
      ]);

    expect(view(syncedAt + LOUNGE_OFFLINE_EXPIRY_MS - 1)).toEqual([
      ['Mixed', ['lounge', 'own'], 0],
      ['Their mix', ['lounge'], 0],
    ]);
    expect(view(syncedAt + LOUNGE_OFFLINE_EXPIRY_MS)).toEqual([
      ['Mixed', ['own'], 1],
      ['Their mix', [], 1],
    ]);
  });

  it('lists an offline Session as a Session, its stored Tracks in play order', () => {
    const [t1, t2] = [entry('t1'), entry('t2')];
    const session: OfflineMark = {
      ...mark('s1', 'Night Shift', [t2, t1]),
      key: 'session:s1',
      kind: 'session',
    };

    const [collection] = offlineCollections([session], [copy(t1), copy(t2)], 2, 3);

    expect(collection!.tracks.map((t) => t.trackId)).toEqual(['t2', 't1']);
    expect(offlineCollectionNoun(collection!)).toBe('Session');
    expect(offlineCollectionNoun({ kind: 'playlist' })).toBe('Playlist');
  });
});

describe('offlinePlayableTracks', () => {
  it('plays each Track from its device copy, never from the server', () => {
    const t1 = entry('t1', { coverImageId: 'c1', vocalMode: 'vocal', hasLyrics: true });
    const [playable] = offlinePlayableTracks([copy(t1)], (trackId) => `blob:audio-${trackId}`);

    expect(playable).toMatchObject({
      queueItemId: 't1',
      trackId: 't1',
      title: 'Title t1',
      artist: 'Artist t1',
      originSessionTitle: 'Session t1',
      durationSeconds: 180,
      coverImageId: 'c1',
      genreTags: ['house'],
      vocalMode: 'vocal',
      hasLyrics: true,
      downloadable: false,
      assets: { final: 'blob:audio-t1', stream: null },
      styleRevision: null,
      blendAnalysis: null,
    });
  });
});

describe('offlineTrackMedia', () => {
  const t1 = entry('t1', { coverImageId: 'c1', vocalMode: 'vocal', hasLyrics: true });
  const t2 = entry('t2', { coverImageId: 'c2' });
  const media = offlineTrackMedia(
    [copy(t1, { lyrics: LYRICS, coverBytes: 10 }), copy(t2)],
    new Map([['c1', 'blob:cover-c1']]),
  );

  it('shows a stored cover, and no art at all where the device holds none', () => {
    expect(media.coverSrc('c1')).toBe('blob:cover-c1');
    expect(media.coverSrc('c1', 'thumb')).toBe('blob:cover-c1');
    expect(media.coverSrc('c2')).toBeNull();
    expect(media.coverSrc(null)).toBeNull();
    expect(media.artwork('c1')).toEqual([{ src: 'blob:cover-c1', sizes: '512x512' }]);
    expect(media.artwork('c2')).toEqual([]);
  });

  it('answers lyrics and Track Data from the device, as final as they will get', async () => {
    expect(await media.lyrics('t1')).toEqual({ ok: true, data: { ...LYRICS, settled: true } });
    expect(await media.lyrics('t2')).toEqual({
      ok: true,
      data: { state: 'instrumental', lines: [], synced: false, settled: true },
    });
    expect(await media.details('t1')).toEqual({ ok: true, data: DETAILS });
    expect((await media.details('gone')).ok).toBe(false);
  });
});
