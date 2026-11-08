'use client';

// Client shell for the offline-store harness page: exposes the store, opened
// over the real IndexedDB backing, the device's offline store as the app opens
// it, and the Offline Library's service-worker setup on `window`, and marks
// readiness via a test id. Its Player plays a Playlist the way the app does
// online, from the audio route, unless the device stores the Track.

import { useEffect, useState } from 'react';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { PlayerProvider, usePlayerActions } from '@/components/player/player-provider';
import { deviceOffline, storedTrackAudio } from '@/lib/offline/device-offline';
import { openIndexedDbBacking } from '@/lib/offline/indexeddb-backing';
import { readyOfflineLibrary } from '@/lib/offline/offline-library-cache';
import { createOfflineStore, type OfflineStore } from '@/lib/offline/offline-store';

declare global {
  interface Window {
    __liedmotifOfflineStoreHarness?: {
      openStore: () => Promise<OfflineStore>;
      readyOfflineLibrary: () => Promise<void>;
      openDeviceStore: () => Promise<void>;
      storedTrackAudio: (trackId: string) => Blob | null;
    };
  }
}

/** A Playlist of one Track, `t1`, streamed from `/api/audio/t1` unless stored. */
const ONLINE_PLAYLIST = { id: 'online-playlist', name: 'Online Playlist' } as PlaylistSummaryItem;
const ONLINE_MEMBER = {
  id: 't1',
  audioUrl: '/api/audio/t1',
  title: 'Harness Track',
  generatedArtistName: null,
  originSessionTitle: null,
  durationSeconds: null,
  coverImageId: null,
  savedAt: null,
  favoritedAt: null,
  inCuratedPlaylist: false,
  genreTags: [],
  vocalMode: 'instrumental',
  hasLyrics: false,
  downloadable: true,
} as unknown as PlaylistMemberItem;

function PlayOnline() {
  const { engagePlaylist } = usePlayerActions();
  return (
    <button
      type="button"
      data-testid="harness-play-online"
      onClick={() => engagePlaylist(ONLINE_PLAYLIST, [ONLINE_MEMBER])}
    >
      Play online
    </button>
  );
}

export function OfflineStoreHarnessClient() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.__liedmotifOfflineStoreHarness = {
      openStore: async () => createOfflineStore(await openIndexedDbBacking()),
      readyOfflineLibrary,
      openDeviceStore: async () => void (await deviceOffline()),
      storedTrackAudio,
    };
    setReady(true);
    return () => {
      delete window.__liedmotifOfflineStoreHarness;
    };
  }, []);
  return (
    <PlayerProvider>
      <main className="p-6 font-mono text-sm">
        <h1>Offline store harness</h1>
        <p data-testid="harness-ready">{ready ? 'ready' : 'loading'}</p>
        <PlayOnline />
      </main>
    </PlayerProvider>
  );
}
