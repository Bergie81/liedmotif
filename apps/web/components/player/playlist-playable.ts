// Project Playlist members into the transport's PlayableTrack shape
// (the transport is generic over an ordered list of playable
// Tracks). A Playlist has no queue slots and no duplicate members, so the
// track id doubles as the traversal key; blend identity is deliberately
// absent — every Playlist edge fails the provenance gates and degrades to a
// plain equal-power crossfade, the designed sound of a shelf of chosen songs.

import type { PlaylistMemberItem } from '@liedmotif/shared';
import type { PlayableTrack } from './playable-track';

export function playlistTracksToPlayable(items: PlaylistMemberItem[]): PlayableTrack[] {
  return items.flatMap((item) => {
    if (!item.audioUrl) return [];
    return [
      {
        queueItemId: item.id,
        trackId: item.id,
        queueState: 'queued' as const,
        vibeSwitchSetAside: false,
        title: item.title,
        artist: item.generatedArtistName,
        originSessionTitle: item.originSessionTitle,
        durationSeconds: item.durationSeconds,
        coverImageId: item.coverImageId,
        savedAt: item.savedAt,
        inCuratedPlaylist: item.inCuratedPlaylist,
        favoritedAt: item.favoritedAt,
        genreTags: item.genreTags,
        vocalMode: item.vocalMode,
        hasLyrics: item.hasLyrics,
        downloadable: item.downloadable,
        // The deck ladder walks final → stream; a member whose download is
        // still in flight simply commits its stream pin.
        assets: {
          final: `${item.audioUrl}?asset=final`,
          stream: `${item.audioUrl}?asset=stream`,
        },
        styleRevision: null,
        targetBpm: null,
        targetKey: null,
        blendAnalysis: null,
      },
    ];
  });
}
