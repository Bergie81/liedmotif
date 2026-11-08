import { describe, expect, it } from 'vitest';
import type { OfflineManifestTrack, TrackDetails } from '@liedmotif/shared';
import { memoryOfflineBacking } from '@/tests/helpers/memory-offline-backing';
import { createOfflineStore, type OfflineStore } from './offline-store';
import { LOUNGE_OFFLINE_EXPIRY_MS } from './offline-sync-plan';
import { createStoredAudio } from './stored-audio';

function presentation(trackId: string, fromLounge = false): OfflineManifestTrack {
  return {
    trackId,
    byteSize: 3,
    version: 'v1',
    title: `Title ${trackId}`,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 200,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge,
  };
}

async function storeWith(...tracks: OfflineManifestTrack[]): Promise<OfflineStore> {
  const store = createOfflineStore(memoryOfflineBacking());
  await store.claim('user-a');
  for (const track of tracks) {
    await store.put({
      trackId: track.trackId,
      version: track.version,
      track,
      details: {} as TrackDetails,
      lyrics: null,
      audio: new Blob([`audio ${track.trackId}`], { type: 'audio/mpeg' }),
      cover: null,
    });
  }
  return store;
}

describe('stored audio', () => {
  it('answers with the stored audio of each Track the device holds', async () => {
    const store = await storeWith(presentation('t1'));
    const audio = createStoredAudio(store, { online: () => true });
    expect(audio.get('t1')).toBeNull();

    await audio.refresh();
    expect(await audio.get('t1')?.text()).toBe('audio t1');
    expect(audio.get('t2')).toBeNull();
  });

  it('follows the store as Tracks arrive and leave', async () => {
    const store = await storeWith(presentation('t1'));
    const audio = createStoredAudio(store, { online: () => true });
    await audio.refresh();

    await store.delete(['t1']);
    await store.put({
      trackId: 't2',
      version: 'v1',
      track: presentation('t2'),
      details: {} as TrackDetails,
      lyrics: null,
      audio: new Blob(['audio t2']),
      cover: null,
    });
    await audio.refresh();
    expect(audio.get('t1')).toBeNull();
    expect(await audio.get('t2')?.text()).toBe('audio t2');
  });

  it('stops answering for a Lounge copy a week after the last successful sync', async () => {
    const store = await storeWith(presentation('own'), presentation('lounge', true));
    const syncedAt = 1_000_000;
    await store.putLastSyncedAt(syncedAt);
    let now = syncedAt + LOUNGE_OFFLINE_EXPIRY_MS - 1;
    const audio = createStoredAudio(store, { online: () => false, now: () => now });
    await audio.refresh();
    expect(audio.get('lounge')).not.toBeNull();

    now = syncedAt + LOUNGE_OFFLINE_EXPIRY_MS;
    expect(audio.get('lounge')).toBeNull();
    expect(audio.get('own')).not.toBeNull();
  });

  // A revoke reaches a stored copy only at the next sync, so online the server
  // decides: another owner's Track streams, and stops once it is no longer
  // Lounge-audible.
  it("streams another owner's Track while online and plays its stored copy offline", async () => {
    const store = await storeWith(presentation('own'), presentation('lounge', true));
    await store.putLastSyncedAt(1_000);
    let online = true;
    const audio = createStoredAudio(store, { online: () => online, now: () => 2_000 });
    await audio.refresh();
    expect(audio.get('lounge')).toBeNull();
    expect(audio.get('own')).not.toBeNull();

    online = false;
    expect(audio.get('lounge')).not.toBeNull();
  });

  it('keeps its last answer when the store cannot be read', async () => {
    const store = await storeWith(presentation('t1'));
    const audio = createStoredAudio(store, { online: () => true });
    await audio.refresh();

    store.list = () => Promise.reject(new Error('IndexedDB went away'));
    await expect(audio.refresh()).resolves.toBeUndefined();
    expect(audio.get('t1')).not.toBeNull();
  });
});
