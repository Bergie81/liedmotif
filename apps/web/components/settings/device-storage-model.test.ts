import { describe, expect, it } from 'vitest';
import type { OfflineManifestTrack } from '@liedmotif/shared';
import type { OfflineMark, OfflineTrackCopy } from '@/lib/offline/offline-store';
import {
  deviceStorage,
  needsHomeScreenHint,
  nextCapStep,
  offlineAvailability,
} from './device-storage-model';

function entry(trackId: string): OfflineManifestTrack {
  return {
    trackId,
    byteSize: 1,
    version: 'v1',
    title: trackId,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 180,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    fromLounge: false,
  };
}

function mark(id: string, name: string, trackIds: string[]): OfflineMark {
  return {
    key: `playlist:${id}`,
    kind: 'playlist',
    id,
    markedAt: 0,
    syncedAt: null,
    manifest: { name, tracks: trackIds.map(entry), leftOutTrackCount: 0 },
  };
}

function copy(trackId: string, audioBytes: number, coverBytes = 0): OfflineTrackCopy {
  return {
    trackId,
    version: 'v1',
    track: entry(trackId),
    details: {} as OfflineTrackCopy['details'],
    lyrics: null,
    audioBytes,
    coverBytes,
  };
}

describe('device storage', () => {
  it('counts each stored Track once in the total, and in every item that lists it', () => {
    const marks = [
      mark('p2', 'Run', ['shared', 'not-yet-stored']),
      mark('p1', 'Focus', ['a', 'shared']),
    ];
    const copies = [copy('a', 100, 10), copy('shared', 200)];

    expect(deviceStorage(marks, copies)).toEqual({
      usedBytes: 310,
      items: [
        { key: 'playlist:p1', kind: 'playlist', id: 'p1', name: 'Focus', bytes: 310 },
        { key: 'playlist:p2', kind: 'playlist', id: 'p2', name: 'Run', bytes: 200 },
      ],
    });
  });
});

describe('offline availability', () => {
  const insecure = { secureContext: false, supported: false };

  it('over plain HTTP, links the instance address when that is HTTPS', () => {
    expect(offlineAvailability(insecure, 'https://music.example.ts.net')).toEqual({
      kind: 'needs-https',
      secureAddress: 'https://music.example.ts.net',
    });
  });

  it('over plain HTTP, offers no link when the instance address is plain HTTP too', () => {
    expect(offlineAvailability(insecure, 'http://192.168.1.10:2206')).toEqual({
      kind: 'needs-https',
      secureAddress: null,
    });
  });

  it('is available in a secure context that can store music', () => {
    expect(offlineAvailability({ secureContext: true, supported: true }, 'http://x')).toEqual({
      kind: 'available',
    });
  });

  // A secure page where offline is simply not offered (no IndexedDB).
  it('has nothing to say on a secure page that offers no offline storage', () => {
    expect(offlineAvailability({ secureContext: true, supported: false }, 'https://x')).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('the iOS Home Screen hint', () => {
  const iPhone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  // iPadOS Safari asks for the desktop site by default, so it reads as a Mac with a touch screen.
  const iPadAsMac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
  const android =
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

  it('shows on an iPhone or iPad in a browser tab', () => {
    expect(needsHomeScreenHint({ userAgent: iPhone, maxTouchPoints: 5, standalone: false })).toBe(
      true,
    );
    expect(
      needsHomeScreenHint({ userAgent: iPadAsMac, maxTouchPoints: 5, standalone: false }),
    ).toBe(true);
  });

  it('stays hidden in the Home Screen app, on a Mac, and on Android', () => {
    expect(needsHomeScreenHint({ userAgent: iPhone, maxTouchPoints: 5, standalone: true })).toBe(
      false,
    );
    expect(
      needsHomeScreenHint({ userAgent: iPadAsMac, maxTouchPoints: 0, standalone: false }),
    ).toBe(false);
    expect(needsHomeScreenHint({ userAgent: android, maxTouchPoints: 5, standalone: false })).toBe(
      false,
    );
  });
});

describe('the cap stepper', () => {
  const GIB = 1024 ** 3;

  it('steps through its choices, from a cap between two of them too', () => {
    expect(nextCapStep(5 * GIB, 'up')).toBe(10 * GIB);
    expect(nextCapStep(5 * GIB, 'down')).toBe(2 * GIB);
    expect(nextCapStep(7 * GIB, 'up')).toBe(10 * GIB);
    expect(nextCapStep(7 * GIB, 'down')).toBe(5 * GIB);
  });

  it('has nowhere to go past either end', () => {
    expect(nextCapStep(1 * GIB, 'down')).toBeNull();
    expect(nextCapStep(50 * GIB, 'up')).toBeNull();
  });
});
