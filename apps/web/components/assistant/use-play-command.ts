'use client';

// A play command from the Assistant, run through the flows the app's own
// pages play music with: a Session opens as its row in My Sessions opens it,
// a Playlist plays as its Play button plays it, and a Track plays as its row
// in the Library does. Whatever those flows ask the server for is all a play
// command can cause: a resumed Session keeps the mode it was left in.

import { useCallback, useEffect, useRef } from 'react';
import type { AssistantPlayCommand } from '@liedmotif/shared';
import { usePlayerContext } from '@/components/player/player-provider';
import { usePlaySessionTrack } from '@/components/player/use-play-session-track';
import { usePlayPlaylist } from '@/components/playlists/use-play-playlist';
import { useOpenSessionPlayer } from '@/components/sessions/use-open-session-player';
import { getAllPlaylistMembers, getLoungePlaylist } from '@/lib/api-client';
import type { PlayStart } from './player-command';

type Source<Kind extends string> = Extract<AssistantPlayCommand['source'], { kind: Kind }>;

/**
 * One function for the life of the shell: a command arrives long after the
 * render that handed it out, so the player and the flows are read when it runs.
 */
export function usePlayCommand(): (play: AssistantPlayCommand) => Promise<PlayStart> {
  const context = usePlayerContext();
  // The flows tell the page they sit on what went wrong, in words. The chat
  // has its own line for a command that failed, so here they are only counted.
  // One count serves every command: the shell runs them one after the other.
  const refusals = useRef(0);
  const openings = useRef(0);
  const refuse = useCallback(() => {
    refusals.current += 1;
  }, []);
  const sessions = useOpenSessionPlayer(() => {
    openings.current += 1;
  });
  const tracks = usePlaySessionTrack(refuse);
  const playlists = usePlayPlaylist(refuse);
  const loungePlaylists = usePlayPlaylist(refuse, { foreign: true });
  const live = useRef({ context, sessions, tracks, playlists, loungePlaylists });
  useEffect(() => {
    live.current = { context, sessions, tracks, playlists, loungePlaylists };
  });
  return useCallback(({ source, track }) => {
    async function playlist(source: Source<'playlist'>): Promise<PlayStart> {
      const members = await getAllPlaylistMembers(
        source.id,
        source.foreign ? (cursor, limit) => getLoungePlaylist(source.id, cursor, limit) : undefined,
      );
      if (!members.ok) return 'failed';
      const { playlist: summary, items } = members.data;
      if (track && !items.some((item) => item.id === track.id && item.audioUrl !== null)) {
        return 'failed';
      }
      if (!(await live.current.context.beginOtherMusic())) return 'declined';
      const refused = refusals.current;
      const flow = source.foreign ? live.current.loungePlaylists : live.current.playlists;
      flow.play(summary, items, track?.id);
      return refusals.current === refused ? 'started' : 'failed';
    }

    async function session(source: Source<'session'>): Promise<PlayStart> {
      const { playback, beginOtherMusic } = live.current.context;
      const engaged = playback?.session?.id === source.id;
      // A Track that is on the deck plays on where it is. Its row would toggle
      // it, and so pause one that plays; a command only ever plays.
      if (track && playback?.player.currentTrack?.trackId === track.id) {
        playback.player.play();
        return 'started';
      }
      // What stays inside the engaged Session replaces no Session that is
      // starting, so it is not asked about; the app's own rows do the same.
      if (!engaged && !(await beginOtherMusic())) return 'declined';
      if (track) {
        const refused = refusals.current;
        const viaSession = await live.current.tracks.playViaSession({
          id: track.id,
          originSessionId: source.id,
        });
        return viaSession && refusals.current === refused ? 'started' : 'failed';
      }
      const opened = openings.current;
      await live.current.sessions.open(source.id);
      if (openings.current === opened) return 'failed';
      // An engaged Session opens with its transport as it stands; the command is to play it.
      if (engaged) live.current.context.playback?.player.play();
      return 'started';
    }

    return source.kind === 'playlist' ? playlist(source) : session(source);
  }, []);
}
