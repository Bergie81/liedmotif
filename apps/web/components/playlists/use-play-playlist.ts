'use client';

// Start Playlist playback (the non-generative Playback source):
// engage the cross-route player with the playlist's ordered membership. The
// page stays put — playback surfaces in the mini player, and the full player
// is one tap away there. Always Play, never Resume — a Playlist has no stored
// position — and the Active Session is left Active-but-idle (the playlist
// controller sends no playback reports, so its top-ups stop on their own).

import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { markPlaylistPlayed } from '@/lib/api-client';
import { usePlayerActions } from '@/components/player/player-provider';

export function usePlayPlaylist(
  onError: (message: string) => void,
  options: {
    /** Another owner's In-Lounge playlist: the play stamp is the
     *  owner's fact and stays untouched; the player mounts the visitor scope. */
    foreign?: boolean;
  } = {},
) {
  const { engagePlaylist, beginOtherMusic } = usePlayerActions();
  const foreign = options.foreign ?? false;

  function play(
    playlist: PlaylistSummaryItem,
    items: PlaylistMemberItem[],
    startTrackId?: string,
  ): void {
    // The full membership rides along (the ordered list renders every member);
    // the controller's projection plays only the members with audio.
    if (!items.some((item) => item.audioUrl !== null)) {
      onError('Nothing in this playlist is playable right now.');
      return;
    }
    void beginOtherMusic().then((ok) => {
      if (!ok) return;
      engagePlaylist(playlist, items, startTrackId ?? null, { foreign });
      // Fire-and-forget: the play stamp orders the Playlists tab and must
      // never block or fail playback.
      if (!foreign) void markPlaylistPlayed(playlist.id);
    });
  }

  return { play };
}
