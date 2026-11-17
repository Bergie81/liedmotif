'use client';

// The player after a receipt. The Assistant writes on the server, past the
// player's own buttons, so what the player already shows of the thing that
// changed is brought in line here: the same state those buttons would have set.

import { useCallback, useEffect, useRef } from 'react';
import type { AssistantReceipt, SessionSummary } from '@liedmotif/shared';
import { adoptStoredPlaybackSettings, usePlayerContext } from '@/components/player/player-provider';
import { optimisticFavoriteFlags } from '@/components/player/track-retention';

/**
 * What to call with each receipt. `refreshChrome` re-reads the shell's own
 * copy of the active Session, which the mini player shows while nothing is
 * engaged in this browser.
 */
export function usePlayerFollowsReceipt(
  refreshChrome: () => void,
): (receipt: AssistantReceipt) => void {
  const { playback, pending, engage } = usePlayerContext();
  // A receipt arrives long after the render that made this callback.
  const playbackRef = useRef(playback);
  const pendingRef = useRef(pending);
  // The engaged Session as last set: receipts of one answer arrive together,
  // before the player re-renders with what the first of them engaged.
  const sessionRef = useRef(playback?.session);
  useEffect(() => {
    playbackRef.current = playback;
    pendingRef.current = pending;
    sessionRef.current = playback?.session;
  }, [playback, pending]);

  return useCallback(
    (receipt) => {
      const live = playbackRef.current;
      // The same Session engaged again is its summary refreshed in place.
      const refreshSession = (id: string, patch: Partial<SessionSummary>) => {
        const session = sessionRef.current;
        if (session?.id !== id) return;
        const next = { ...session, ...patch };
        sessionRef.current = next;
        engage(next, { autoplay: false });
      };
      switch (receipt.action) {
        case 'favoriteTrack': {
          const track = live?.player.currentTrack;
          if (!live || track?.trackId !== receipt.track.id) return;
          // The star's own tap sets these flags; curated membership is not its to move.
          live.player.applyRetentionFlags(
            track.trackId,
            optimisticFavoriteFlags(track, true, new Date().toISOString()),
            track.inCuratedPlaylist,
          );
          return;
        }
        case 'addToPlaylist': {
          const track = live?.player.currentTrack;
          if (!live || !track || !receipt.tracks.some(({ id }) => id === track.trackId)) return;
          // What the server's flag sync makes of the membership: any Playlist
          // saves the Track, Favorites also favorites it.
          const now = new Date().toISOString();
          live.player.applyRetentionFlags(
            track.trackId,
            receipt.retention === 'favorite'
              ? optimisticFavoriteFlags(track, true, now)
              : { savedAt: track.savedAt ?? now, favoritedAt: track.favoritedAt },
            track.inCuratedPlaylist || receipt.retention === 'curated',
          );
          return;
        }
        case 'newMusicOff':
          refreshSession(receipt.session.id, { sessionMode: 'repeat' });
          refreshChrome();
          return;
        case 'renameSession':
          refreshSession(receipt.session.id, { title: receipt.session.name });
          refreshChrome();
          return;
        case 'renameTrack':
          // The Rename in the player's own menu applies a title the same way.
          if (receipt.track.name !== null) {
            live?.player.applyTrackTitle(receipt.track.id, receipt.track.name);
          }
          return;
        case 'changeSetting':
          if (receipt.setting === 'blend' || receipt.setting === 'crossfadeSeconds') {
            adoptStoredPlaybackSettings({ playback: live, pending: pendingRef.current });
          }
          return;
        default:
          return;
      }
    },
    [engage, refreshChrome],
  );
}
