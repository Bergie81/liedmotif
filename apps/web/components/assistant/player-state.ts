// What the chat panel tells the Assistant about the player. The player lives
// in the browser, so each message carries what it has engaged; the server
// trusts none of it beyond looking the ids up as the asking user.

import type { AssistantPlayerState } from '@liedmotif/shared';
import type { PlaybackControllerState } from '@/components/player/playback-controller-api';
import type { EngagedSource } from '@/components/player/player-provider-model';

/** The live playback as far as the Assistant is told about it. */
export interface PlayerSnapshot {
  source: EngagedSource;
  player: {
    status: PlaybackControllerState['status'];
    currentTrack: { trackId: string } | null;
  };
}

/**
 * The player state for one request, or `undefined` when there is nothing to
 * tell. An offline collection is nothing: it plays from this device where no
 * server can be asked, under a key that is not a Session or Playlist id.
 * `sleepTimerEndsAt` is when the player's running Sleep Timer ends, null
 * while none runs.
 */
export function assistantPlayerState(
  playback: PlayerSnapshot | null,
  sleepTimerEndsAt: number | null = null,
): AssistantPlayerState | undefined {
  if (!playback || playback.source.kind === 'offline') return undefined;
  const { source, player } = playback;
  return {
    source:
      source.kind === 'session'
        ? { kind: 'session', id: source.session.id }
        : { kind: 'playlist', id: source.playlist.id },
    trackId: player.currentTrack?.trackId ?? null,
    playing: player.status === 'playing',
    ...(sleepTimerEndsAt !== null && { sleepTimerEndsAt }),
  };
}
