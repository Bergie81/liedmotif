import { describe, expect, it, vi } from 'vitest';
import type {
  OfflineManifest,
  OfflineManifestTrack,
  TrackDetails,
  TrackLyrics,
} from '@liedmotif/shared';
import { memoryOfflineBacking } from '@/tests/helpers/memory-offline-backing';
import { createOfflineStore, type OfflineStore } from './offline-store';
import {
  createOfflineSync,
  type OfflineMarkStatus,
  type OfflineServer,
  type OfflineSync,
} from './offline-sync';

const MB = 1_000_000;

function track(
  trackId: string,
  overrides: Partial<OfflineManifestTrack> = {},
): OfflineManifestTrack {
  return {
    trackId,
    byteSize: 4 * MB,
    version: 'v1',
    title: `Title ${trackId}`,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 180,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge: false,
    ...overrides,
  };
}

/** A server holding Playlists and Sessions by id; tests edit them between syncs. */
function fakeServer() {
  const playlists = new Map<string, OfflineManifest>();
  const sessions = new Map<string, OfflineManifest>();
  const audioCalls: string[] = [];
  const manifestCalls: string[] = [];
  const failing = new Set<string>();
  const failingCovers = new Set<string>();
  let reachable = true;
  let holdAudio: Promise<void> | null = null;
  let holdManifest: Promise<void> | null = null;
  const server: OfflineServer = {
    async manifest(mark) {
      manifestCalls.push(mark.id);
      if (holdManifest) await holdManifest;
      if (!reachable) throw new TypeError('Failed to fetch');
      return (mark.kind === 'session' ? sessions : playlists).get(mark.id) ?? 'gone';
    },
    async audio(trackId) {
      audioCalls.push(trackId);
      if (holdAudio) await holdAudio;
      if (failing.delete(trackId) || !reachable) throw new TypeError('Failed to fetch');
      return new Blob(['audio'], { type: 'audio/mpeg' });
    },
    async cover(coverImageId) {
      if (failingCovers.delete(coverImageId)) throw new TypeError('Failed to fetch');
      return new Blob(['cover'], { type: 'image/webp' });
    },
    async details(trackId) {
      return { title: `Details ${trackId}` } as unknown as TrackDetails;
    },
    async lyrics() {
      return { state: 'ready', lines: [], synced: false, settled: true } satisfies TrackLyrics;
    },
  };
  return {
    server,
    audioCalls,
    manifestCalls,
    setPlaylist: (id: string, tracks: OfflineManifestTrack[], leftOutTrackCount = 0) =>
      playlists.set(id, { name: `Playlist ${id}`, tracks, leftOutTrackCount }),
    deletePlaylist: (id: string) => playlists.delete(id),
    setSession: (id: string, tracks: OfflineManifestTrack[]) =>
      sessions.set(id, { name: `Session ${id}`, tracks, leftOutTrackCount: 0 }),
    deleteSession: (id: string) => sessions.delete(id),
    failAudioOnce: (trackId: string) => failing.add(trackId),
    failCoverOnce: (coverImageId: string) => failingCovers.add(coverImageId),
    setReachable: (value: boolean) => {
      reachable = value;
    },
    holdAudioUntil: (gate: Promise<void> | null) => {
      holdAudio = gate;
    },
    holdManifestUntil: (gate: Promise<void> | null) => {
      holdManifest = gate;
    },
  };
}

async function setup(capBytes = 100 * MB) {
  const remote = fakeServer();
  const store = createOfflineStore(memoryOfflineBacking());
  await store.claim('user-a');
  const persist = vi.fn();
  const offline = createOfflineSync({ store, server: remote.server, capBytes, persist });
  return { remote, store, offline, persist };
}

/** Marks a Playlist and waits until the sync it starts has settled. */
async function markAndSettle(offline: OfflineSync, playlistId: string) {
  const result = await offline.mark('playlist', playlistId);
  await offline.settled();
  return result;
}

const storedIds = async (store: OfflineStore) =>
  (await store.list()).map((copy) => copy.trackId).sort();

describe('offline sync', () => {
  it('never calls a copy ready while the manifest leaves Tracks of the collection out', async () => {
    const { remote, offline } = await setup();
    remote.setPlaylist('p1', [track('a'), track('b')], 1);

    await markAndSettle(offline, 'p1');

    expect(offline.status().get('playlist:p1')).toEqual({ state: 'paused', done: 2, total: 3 });

    remote.setPlaylist('p1', [track('a'), track('b'), track('c')]);
    await offline.sync();

    expect(offline.status().get('playlist:p1')).toEqual({ state: 'ready', total: 3 });
  });

  it('holds back a mark stored without a left-out count until a sync confirms the copy', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a')]);
    await markAndSettle(offline, 'p1');
    const [mark] = await store.marks();
    const { name, tracks } = mark!.manifest;
    await store.putMark({ ...mark!, manifest: { name, tracks } as OfflineManifest });
    remote.setReachable(false);

    await offline.claim('user-a');
    expect(offline.status().get('playlist:p1')).toEqual({ state: 'paused', done: 1, total: 1 });

    remote.setReachable(true);
    await offline.sync();
    expect(offline.status().get('playlist:p1')).toEqual({ state: 'ready', total: 1 });
  });

  it('never calls a collection with no Tracks ready', async () => {
    const { remote, offline } = await setup();
    remote.setPlaylist('p1', []);

    await markAndSettle(offline, 'p1');

    expect(offline.status().get('playlist:p1')).toEqual({ state: 'empty' });
  });

  it('marking a Playlist downloads its Tracks, counting up, then reports it ready offline', async () => {
    const { remote, store, offline, persist } = await setup();
    remote.setPlaylist('p1', [track('a', { vocalMode: 'vocal', hasLyrics: true }), track('b')]);
    const seen: OfflineMarkStatus[] = [];
    offline.subscribe(() => {
      const status = offline.status().get('playlist:p1');
      if (status) seen.push(status);
    });

    expect(await markAndSettle(offline, 'p1')).toEqual({ marked: true });

    expect(seen).toContainEqual({ state: 'downloading', done: 1, total: 2 });
    expect(offline.status().get('playlist:p1')).toEqual({ state: 'ready', total: 2 });
    expect(await storedIds(store)).toEqual(['a', 'b']);
    const [vocal] = await store.list();
    expect(vocal).toMatchObject({
      details: { title: 'Details a' },
      lyrics: { state: 'ready' },
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('refuses a mark over the cap before downloading anything, and keeps no mark', async () => {
    const { remote, store, offline } = await setup(10 * MB);
    remote.setPlaylist('big', [track('a', { byteSize: 6 * MB }), track('b', { byteSize: 6 * MB })]);

    const result = await markAndSettle(offline, 'big');

    expect(result).toEqual({
      marked: false,
      refusal: { key: 'playlist:big', neededBytes: 12 * MB, freeBytes: 10 * MB },
    });
    expect(remote.audioCalls).toEqual([]);
    expect(await store.marks()).toEqual([]);
    expect(offline.status().has('playlist:big')).toBe(false);
  });

  it('follows the Playlist: an added Track is downloaded, a removed one deleted, the rest kept', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a'), track('b')]);
    await markAndSettle(offline, 'p1');

    remote.setPlaylist('p1', [track('b'), track('c')]);
    await offline.sync();

    expect(await storedIds(store)).toEqual(['b', 'c']);
    expect(remote.audioCalls).toEqual(['a', 'b', 'c']);
    expect(offline.status().get('playlist:p1')).toEqual({ state: 'ready', total: 2 });
  });

  it('drops the mark and its Tracks when the server no longer has the Playlist', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a')]);
    await markAndSettle(offline, 'p1');

    remote.deletePlaylist('p1');
    await offline.sync();

    expect(await store.marks()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(offline.status().has('playlist:p1')).toBe(false);
  });

  it('drops a deleted Session’s mark and Tracks, keeping one an offline Playlist still lists', async () => {
    const { remote, store, offline } = await setup();
    remote.setSession('s1', [track('ephemeral'), track('saved')]);
    remote.setPlaylist('p1', [track('saved')]);
    await offline.mark('session', 's1');
    await offline.settled();
    await markAndSettle(offline, 'p1');

    remote.deleteSession('s1');
    await offline.sync();

    expect((await store.marks()).map((mark) => mark.key)).toEqual(['playlist:p1']);
    expect(await storedIds(store)).toEqual(['saved']);
    expect(remote.audioCalls).toEqual(['ephemeral', 'saved']);
  });

  it('resumes an interrupted sync with only the Tracks it did not finish', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a'), track('b')]);
    remote.failAudioOnce('b');

    await markAndSettle(offline, 'p1');
    expect(offline.status().get('playlist:p1')).toEqual({ state: 'paused', done: 1, total: 2 });

    await offline.sync();
    expect(remote.audioCalls).toEqual(['a', 'b', 'b']);
    expect(await storedIds(store)).toEqual(['a', 'b']);
    expect(offline.status().get('playlist:p1')).toEqual({ state: 'ready', total: 2 });
  });

  // Art never blocks a Track from landing, but a cover that did not arrive is
  // owed: the next sync fetches it, the audio staying as it is.
  it('fetches a cover that failed to arrive again on the next sync, keeping the audio', async () => {
    const { remote, store, offline } = await setup();
    const coverImageId = '00000000-0000-4000-8000-0000000000c1';
    remote.setPlaylist('p1', [track('a', { coverImageId })]);
    remote.failCoverOnce(coverImageId);

    await markAndSettle(offline, 'p1');
    expect((await store.list())[0]?.coverBytes).toBe(0);

    await offline.sync();
    expect((await store.list())[0]?.coverBytes).toBeGreaterThan(0);
    expect(remote.audioCalls).toEqual(['a']);
  });

  it('unmarking frees its Tracks at once, even unreachable, but keeps those another mark lists', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a'), track('shared')]);
    remote.setPlaylist('p2', [track('shared')]);
    await markAndSettle(offline, 'p1');
    await markAndSettle(offline, 'p2');

    remote.setReachable(false);
    await offline.unmark('playlist', 'p1');

    expect(await storedIds(store)).toEqual(['shared']);
    expect((await store.marks()).map((mark) => mark.key)).toEqual(['playlist:p2']);
    expect(offline.status().has('playlist:p1')).toBe(false);
  });

  // A Lounge copy plays for a week after the server last confirmed it; that
  // confirmation is a sync that heard every mark's manifest.
  it('records when a sync last heard every mark from the server, and not a sync that could not', async () => {
    const remote = fakeServer();
    const store = createOfflineStore(memoryOfflineBacking());
    await store.claim('user-a');
    let clock = 1_000;
    const offline = createOfflineSync({
      store,
      server: remote.server,
      capBytes: 100 * MB,
      now: () => clock,
    });
    remote.setPlaylist('lounge', [track('a', { fromLounge: true })]);
    expect(await store.lastSyncedAt()).toBeNull();

    await markAndSettle(offline, 'lounge');
    expect(await store.lastSyncedAt()).toBe(1_000);

    clock = 2_000;
    remote.setReachable(false);
    await offline.sync();
    expect(await store.lastSyncedAt()).toBe(1_000);

    remote.setReachable(true);
    await offline.sync();
    expect(await store.lastSyncedAt()).toBe(2_000);
  });

  it('a wipe during a download leaves nothing behind', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a'), track('b')]);
    let release!: () => void;
    remote.holdAudioUntil(new Promise<void>((resolve) => (release = resolve)));

    await offline.mark('playlist', 'p1');
    const syncing = offline.settled();
    await vi.waitFor(() => expect(remote.audioCalls).toContain('a'));

    const wiping = offline.wipe();
    release();
    await Promise.all([wiping, syncing]);

    expect(await store.list()).toEqual([]);
    expect(await store.marks()).toEqual([]);
    expect(offline.status().size).toBe(0);
  });

  // Marking asks the server first; a clear, wipe or unmark made meanwhile is
  // the later word, so the mark's answer must not land behind it.
  it('a clear while a mark waits for the server leaves no mark and downloads nothing', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a')]);
    let release!: () => void;
    remote.holdManifestUntil(new Promise<void>((resolve) => (release = resolve)));

    const marking = offline.mark('playlist', 'p1');
    marking.catch(() => undefined);
    await vi.waitFor(() => expect(remote.manifestCalls).toEqual(['p1']));
    await offline.clear();
    remote.holdManifestUntil(null);
    release();
    await expect(marking).rejects.toThrow();
    await offline.settled();

    expect(await store.marks()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(remote.audioCalls).toEqual([]);
  });

  it('refuses a cap below what the device holds, keeping the cap it had', async () => {
    const { remote, offline } = await setup();
    remote.setPlaylist('p1', [track('a'), track('b')]);
    await markAndSettle(offline, 'p1');

    // Each fake Track stores 5 bytes of audio.
    expect(await offline.setCap(9)).toEqual({ set: false, usedBytes: 10 });
    expect((await offline.contents()).capBytes).toBe(100 * MB);
  });

  // The cap is one promise across the plan, the store's usage and the set-cap
  // check: each fake Track stores 5 bytes of audio and a 5-byte cover.
  it('admits a mark only when its audio and covers fit, so the device never ends up over the cap', async () => {
    const coverImageId = '00000000-0000-4000-8000-0000000000c2';
    const exact = { byteSize: 5, coverImageId, coverByteSize: 5 };
    const tight = await setup(19);
    tight.remote.setPlaylist('p1', [track('a', exact), track('b', exact)]);
    expect(await markAndSettle(tight.offline, 'p1')).toEqual({
      marked: false,
      refusal: { key: 'playlist:p1', neededBytes: 20, freeBytes: 19 },
    });
    expect(await tight.store.usage()).toBe(0);

    const { remote, store, offline } = await setup(20);
    remote.setPlaylist('p1', [track('a', exact), track('b', exact)]);
    expect(await markAndSettle(offline, 'p1')).toEqual({ marked: true });
    expect(await store.usage()).toBe(20);
    expect(await offline.setCap(19)).toEqual({ set: false, usedBytes: 20 });
    expect(await offline.setCap(20)).toEqual({ set: true });
  });

  it('leaves a missing cover that no longer fits for a later sync, keeping the audio', async () => {
    const coverImageId = '00000000-0000-4000-8000-0000000000c3';
    const { remote, store, offline } = await setup(10);
    remote.setPlaylist('p1', [track('a', { byteSize: 5, coverImageId, coverByteSize: 5 })]);
    remote.failCoverOnce(coverImageId);
    await markAndSettle(offline, 'p1');
    expect(await offline.setCap(5)).toEqual({ set: true });
    await offline.settled();

    await offline.sync();
    expect(await store.usage()).toBe(5);

    expect(await offline.setCap(10)).toEqual({ set: true });
    await offline.settled();
    expect(await store.usage()).toBe(10);
    expect(remote.audioCalls).toEqual(['a']);
  });

  // A second runner over the same store is another tab, or the next app open.
  it('keeps a new cap on the device, where it decides the next mark in any tab', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a', { byteSize: 6 * MB })]);

    expect(await offline.setCap(5 * MB)).toEqual({ set: true });

    const otherTab = createOfflineSync({ store, server: remote.server, capBytes: 100 * MB });
    expect((await otherTab.contents()).capBytes).toBe(5 * MB);
    expect(await markAndSettle(otherTab, 'p1')).toMatchObject({ marked: false });
  });

  it('a raised cap lets a mark that outgrew the old one catch up, nothing having been evicted', async () => {
    const { remote, store, offline } = await setup(10 * MB);
    remote.setPlaylist('p1', [track('a')]);
    await markAndSettle(offline, 'p1');
    const big = { byteSize: 6 * MB };
    remote.setPlaylist('p1', [track('a'), track('b', big), track('c', big)]);
    await offline.sync();
    expect(offline.status().get('playlist:p1')).toMatchObject({ state: 'refused' });
    expect(await storedIds(store)).toEqual(['a']);

    await offline.setCap(20 * MB);
    await offline.settled();

    expect(offline.status().get('playlist:p1')).toEqual({ state: 'ready', total: 3 });
  });

  it('clearing empties the store and every mark, and the device can mark again after', async () => {
    const { remote, store, offline } = await setup();
    remote.setPlaylist('p1', [track('a')]);
    remote.setPlaylist('p2', [track('b')]);
    await markAndSettle(offline, 'p1');
    await markAndSettle(offline, 'p2');

    await offline.clear();

    expect(await store.list()).toEqual([]);
    expect(await store.marks()).toEqual([]);
    expect(offline.status().size).toBe(0);
    expect(await markAndSettle(offline, 'p1')).toEqual({ marked: true });
  });
});
