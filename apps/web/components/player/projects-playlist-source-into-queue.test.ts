import { describe, expect, it } from 'vitest';
import type { PlayableTrack } from './playable-track';
import { playlistQueueSnapshot } from './use-playback-source-queue';

function playable(trackId: string): PlayableTrack {
  return {
    queueItemId: trackId,
    trackId,
    queueState: 'queued',
    vibeSwitchSetAside: false,
    title: 'Night Signal',
    artist: 'Liedmotif',
    originSessionTitle: 'Night Drive',
    durationSeconds: 180,
    coverImageId: null,
    savedAt: '2026-07-23T10:00:00.000Z',
    favoritedAt: null,
    inCuratedPlaylist: false,
    genreTags: ['ambient'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    assets: { final: `/api/audio/${trackId}`, stream: null },
    styleRevision: 0,
    targetBpm: null,
    targetKey: null,
    blendAnalysis: null,
  };
}

describe('playlistQueueSnapshot', () => {
  it('projects ordered membership without Session generation state', () => {
    const first = playable('00000000-0000-4000-8000-000000000001');
    const selected = playable('00000000-0000-4000-8000-000000000002');

    expect(playlistQueueSnapshot([first, selected], selected.trackId)).toEqual({
      kind: 'playlist',
      tracks: [first, selected],
      queueItemIds: new Set([first.queueItemId, selected.queueItemId]),
      currentQueueItemId: selected.trackId,
      currentTrackId: selected.trackId,
    });
  });
});
