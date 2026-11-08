// @vitest-environment jsdom

// A Lounge copy stops playing a week after the device's last successful sync.
// The Offline Library can stay open far longer — a Home Screen app resumed
// from the background days later — so it judges expiry again when the page
// returns to the foreground and when a collection is tapped, not only when it
// first read the store.

import { act, createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OfflineManifestTrack, TrackDetails } from '@liedmotif/shared';
import { memoryOfflineBacking } from '@/tests/helpers/memory-offline-backing';
import { createOfflineStore, type OfflineBacking } from '@/lib/offline/offline-store';
import { LOUNGE_OFFLINE_EXPIRY_MS } from '@/lib/offline/offline-sync-plan';

const device = vi.hoisted(() => ({ backing: null as OfflineBacking | null }));
const engageOffline = vi.hoisted(() => vi.fn());

vi.mock('@/lib/offline/offline-support', () => ({ offlineSupported: () => true }));
vi.mock('@/lib/offline/indexeddb-backing', () => ({
  openIndexedDbBacking: async () => device.backing,
}));
vi.mock('@/components/player/player-provider', () => ({
  PlayerProvider: ({ children }: { children: unknown }) => children,
  usePlayerContext: () => ({ playback: null, engageOffline }),
}));

const SYNCED_AT = Date.UTC(2026, 10, 1);

function entry(trackId: string, fromLounge: boolean): OfflineManifestTrack {
  return {
    trackId,
    byteSize: 3,
    version: 'v1',
    title: `Title ${trackId}`,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 180,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge,
  };
}

/** A device holding one Playlist: the listener's own Track and a Lounge Track. */
async function seedDevice() {
  device.backing = memoryOfflineBacking();
  const store = createOfflineStore(device.backing);
  await store.claim('user-a');
  const tracks = [entry('own', false), entry('lounge', true)];
  for (const track of tracks) {
    await store.put({
      trackId: track.trackId,
      version: 'v1',
      track,
      details: {} as TrackDetails,
      lyrics: null,
      audio: new Blob(['abc'], { type: 'audio/mpeg' }),
      cover: null,
    });
  }
  await store.putMark({
    key: 'playlist:p1',
    kind: 'playlist',
    id: 'p1',
    markedAt: SYNCED_AT,
    syncedAt: SYNCED_AT,
    manifest: { name: 'Commute', tracks, leftOutTrackCount: 0 },
  });
  await store.putLastSyncedAt(SYNCED_AT);
}

/** A fresh page: the library reads the store once per page. */
async function openLibrary() {
  vi.resetModules();
  const { OfflineLibrary } = await import('./offline-library');
  render(h(OfflineLibrary));
  return screen.findByTestId('offline-collection');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SYNCED_AT + 1000);
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  engageOffline.mockClear();
  await seedDevice();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pastExpiry = () => vi.setSystemTime(SYNCED_AT + LOUNGE_OFFLINE_EXPIRY_MS + 1000);

it('holds back an expired Lounge copy once the page comes back to the foreground', async () => {
  const row = await openLibrary();
  expect(row.textContent).toContain('2 Tracks');

  pastExpiry();
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  expect(row.textContent).toContain('1 Track · 1 expired');
  expect(row.textContent).toContain('Go online to refresh');
});

it('plays only what has not expired when a collection is tapped, even with the page never hidden', async () => {
  const row = await openLibrary();

  pastExpiry();
  fireEvent.click(row);

  expect(engageOffline).toHaveBeenCalledTimes(1);
  expect(
    engageOffline.mock.calls[0]![0].tracks.map((track: { trackId: string }) => track.trackId),
  ).toEqual(['own']);
  expect(row.textContent).toContain('1 expired');
});
