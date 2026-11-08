import { resolveObjectURL } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { OfflineManifestTrack, TrackDetails } from '@liedmotif/shared';
import { memoryOfflineBacking } from '@/tests/helpers/memory-offline-backing';
import { createOfflineStore, type OfflineMark, type OfflineTrackInput } from './offline-store';

function presentation(trackId: string): OfflineManifestTrack {
  return {
    trackId,
    byteSize: 3,
    version: 'v1',
    title: `Title ${trackId}`,
    artist: 'Night Shift',
    originSessionTitle: 'Late Bus',
    durationSeconds: 200,
    coverImageId: null,
    genreTags: ['lofi'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge: false,
  };
}

const details = { title: 'Track Data title' } as unknown as TrackDetails;

function input(trackId: string, overrides: Partial<OfflineTrackInput> = {}): OfflineTrackInput {
  return {
    trackId,
    version: 'v1',
    track: presentation(trackId),
    details,
    lyrics: null,
    audio: new Blob(['abc'], { type: 'audio/mpeg' }),
    cover: new Blob(['xy'], { type: 'image/webp' }),
    ...overrides,
  };
}

async function read(url: string | null): Promise<string | null> {
  if (url === null) return null;
  return (await resolveObjectURL(url)?.text()) ?? null;
}

function playlistMark(id: string, trackIds: string[]): OfflineMark {
  return {
    key: `playlist:${id}`,
    kind: 'playlist',
    id,
    markedAt: 1,
    syncedAt: null,
    manifest: { name: `Playlist ${id}`, tracks: trackIds.map(presentation), leftOutTrackCount: 0 },
  };
}

/** A store as the app uses it: claimed by the signed-in User. */
async function claimedStore() {
  const store = createOfflineStore(memoryOfflineBacking());
  await store.claim('user-a');
  return store;
}

describe('offline store', () => {
  it('keeps a Track with its metadata and plays its audio and cover back through object URLs', async () => {
    const store = await claimedStore();
    await store.put(input('t1'));

    const [copy] = await store.list();
    expect(copy).toMatchObject({
      trackId: 't1',
      version: 'v1',
      track: { title: 'Title t1', artist: 'Night Shift' },
      details,
      lyrics: null,
      audioBytes: 3,
      coverBytes: 2,
    });
    expect(await read(await store.getObjectUrl('t1', 'audio'))).toBe('abc');
    expect(await read(await store.getObjectUrl('t1', 'cover'))).toBe('xy');
    expect(await store.getObjectUrl('missing', 'audio')).toBeNull();
  });

  it('refreshes metadata without audio and keeps the audio it already holds', async () => {
    const store = await claimedStore();
    await store.put(input('t1'));
    await store.put(
      input('t1', {
        version: 'v2',
        track: { ...presentation('t1'), title: 'Renamed' },
        audio: undefined,
        cover: null,
      }),
    );

    const [copy] = await store.list();
    expect(copy).toMatchObject({ version: 'v2', track: { title: 'Renamed' }, coverBytes: 0 });
    expect(await read(await store.getObjectUrl('t1', 'audio'))).toBe('abc');
    expect(await store.getObjectUrl('t1', 'cover')).toBeNull();
  });

  it('refuses a metadata-only put for a Track it does not hold', async () => {
    const store = await claimedStore();
    await expect(store.put(input('t1', { audio: undefined }))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it('reports usage as every stored byte and frees it on delete', async () => {
    const store = await claimedStore();
    await store.put(input('t1'));
    await store.put(input('t2'));
    expect(await store.usage()).toBe(10);

    await store.delete(['t1']);
    expect((await store.list()).map((copy) => copy.trackId)).toEqual(['t2']);
    expect(await store.getObjectUrl('t1', 'audio')).toBeNull();
    expect(await store.usage()).toBe(5);
  });

  it('keeps marks next to the Tracks', async () => {
    const store = await claimedStore();
    await store.putMark(playlistMark('a', ['t1']));
    await store.putMark(playlistMark('b', []));
    await store.putMark({ ...playlistMark('a', ['t1', 't2']), syncedAt: 5 });
    await store.deleteMark('playlist:b');

    expect(await store.marks()).toEqual([{ ...playlistMark('a', ['t1', 't2']), syncedAt: 5 }]);
  });

  it('wipes every Track, file and mark', async () => {
    const store = await claimedStore();
    await store.put(input('t1'));
    await store.putMark(playlistMark('a', ['t1']));

    await store.wipe();

    expect(await store.list()).toEqual([]);
    expect(await store.marks()).toEqual([]);
    expect(await store.usage()).toBe(0);
    expect(await store.getObjectUrl('t1', 'audio')).toBeNull();
  });

  it('belongs to one User: a different User claiming it finds it empty, the same User keeps it', async () => {
    const store = createOfflineStore(memoryOfflineBacking());
    await store.claim('user-a');
    await store.put(input('t1'));
    await store.putMark(playlistMark('a', ['t1']));

    await store.claim('user-a');
    expect(await store.list()).toHaveLength(1);

    await store.claim('user-b');
    expect(await store.list()).toEqual([]);
    expect(await store.marks()).toEqual([]);
  });

  it("keeps the device's cap through a wipe and another User's claim", async () => {
    const store = await claimedStore();
    await store.putCap(20);

    await store.wipe();
    expect(await store.cap()).toBe(20);

    await store.claim('user-b');
    expect(await store.cap()).toBe(20);
  });

  // Signing out wipes the store from one tab while another tab's sync may still
  // be writing: an owner-less store takes nothing, so nothing comes back.
  it('takes no Track or mark once wiped, until a User claims it again', async () => {
    const store = createOfflineStore(memoryOfflineBacking());
    await store.claim('user-a');
    await store.wipe();

    await expect(store.put(input('t1'))).rejects.toThrow();
    await expect(store.putMark(playlistMark('a', ['t1']))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
    expect(await store.marks()).toEqual([]);

    await store.claim('user-b');
    await store.put(input('t1'));
    expect(await store.list()).toHaveLength(1);
  });

  // Two stores over one backing are two tabs. Another User signing in elsewhere
  // claims the device while this tab's sync is still fetching the first User's
  // music: none of it may land in the new owner's store.
  it('takes no write from a tab once another tab claims it for another User', async () => {
    const backing = memoryOfflineBacking();
    const firstTab = createOfflineStore(backing);
    const otherTab = createOfflineStore(backing);
    await firstTab.claim('user-a');
    await otherTab.claim('user-b');

    await expect(firstTab.put(input('t1'))).rejects.toThrow();
    await expect(firstTab.putMark(playlistMark('a', ['t1']))).rejects.toThrow();
    await expect(firstTab.putLastSyncedAt(5)).rejects.toThrow();
    expect(await otherTab.list()).toEqual([]);
    expect(await otherTab.marks()).toEqual([]);
    expect(await otherTab.lastSyncedAt()).toBeNull();

    await otherTab.put(input('t1'));
    expect(await otherTab.list()).toHaveLength(1);
  });
});
