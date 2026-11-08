import { describe, expect, it } from 'vitest';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { playlistTracksToPlayable } from './playlist-playable';
import { presentPlaybackMode, resolveCoverImageId } from './player-presentation';

function member(overrides: Partial<PlaylistMemberItem> = {}): PlaylistMemberItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Glass Horizon',
    generatedArtistName: 'Liedmotif',
    status: 'ready',
    durationSeconds: 187,
    coverImageId: '00000000-0000-4000-8000-0000000000c1',
    audioUrl: '/api/audio/00000000-0000-4000-8000-000000000001',
    savedAt: '2026-07-23T10:00:00.000Z',
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: ['ambient'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    position: 0,
    originSessionTitle: 'Focus Flow',
    owner: null,
    ...overrides,
  };
}

describe('playlistTracksToPlayable', () => {
  it('projects members onto the transport shape: track id keys, pinned asset ladder', () => {
    const [track] = playlistTracksToPlayable([member()]);
    expect(track?.queueItemId).toBe(member().id);
    expect(track?.trackId).toBe(member().id);
    expect(track?.originSessionTitle).toBe('Focus Flow');
    expect(track?.assets).toEqual({
      final: '/api/audio/00000000-0000-4000-8000-000000000001?asset=final',
      stream: '/api/audio/00000000-0000-4000-8000-000000000001?asset=stream',
    });
  });

  it('carries NO blend identity — every playlist edge degrades to the plain crossfade', () => {
    const [track] = playlistTracksToPlayable([member()]);
    expect(track?.styleRevision).toBeNull();
    expect(track?.targetBpm).toBeNull();
    expect(track?.targetKey).toBeNull();
    expect(track?.blendAnalysis).toBeNull();
  });

  it('drops members without audio (an unplayable member never enters the projection)', () => {
    const tracks = playlistTracksToPlayable([
      member(),
      member({ id: '00000000-0000-4000-8000-000000000002', audioUrl: null }),
    ]);
    expect(tracks.map((t) => t.trackId)).toEqual([member().id]);
  });
});

describe('source-aware presentation', () => {
  it('playback modes read Playlist wording for a Playlist source', () => {
    expect(presentPlaybackMode('loop-session', 'Playlist').label).toBe('Loop Playlist');
    expect(presentPlaybackMode('shuffle', 'Playlist').label).toBe('Shuffle Playlist');
    expect(presentPlaybackMode('loop-session').label).toBe('Loop Session');
  });

  it('per-track art wins for a Playlist (null session), Session Cover wins for a Session', () => {
    const player = {
      sessionCoverImageId: null,
      currentTrack: { coverImageId: 'track-art' },
    };
    expect(resolveCoverImageId(player, null)).toBe('track-art');
    expect(resolveCoverImageId(player, { coverImageId: 'session-art' })).toBe('session-art');
  });
});
