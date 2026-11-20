// `play`: starts music that is not in the player yet. Like the other player
// tools it does nothing itself: it reads, as the asking user, whether the
// Session, Playlist or Track is theirs to play and has something to play, and
// hands the browser a command. The browser then runs the app's own play flow
// for it, so resuming a Session is the same request the Resume button sends.

import { getOwnedTrackSummary, getPlayableTrackSession, listSessionTracks } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_PLAYLIST_PAGE_LIMIT,
  playInputSchema,
  type AssistantPlayCommand,
  type PlayInput,
} from '@liedmotif/shared';
import { toPlaylistMemberItem } from '@/lib/library/playlists';
import { NO_SUCH_SESSION, NO_SUCH_TRACK } from './library-action';
import { quoted } from './music-names';
import { handedOver, refused } from './player-tools';
import { isId, ownSession, readablePlaylist, readableTrackTitle } from './readable-music';
import { PLAY_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

/** What a command plays, or the reason there is nothing to hand over. */
type Checked = Pick<AssistantPlayCommand, 'source' | 'track'> | { why: string };

const NO_SUCH_PLAYLIST = 'No Playlist with that id.';

/**
 * One of the asker's own Tracks with the Session it plays through, which is
 * how its row in the Library plays it. A Track that has outlived its Session
 * only previews on a page there, and another user's plays inside the Playlist
 * it is shared in: neither can be started through a Session.
 */
async function trackInItsSession(asker: AssistantAsker, trackId: string): Promise<Checked> {
  const { db, userId, player } = asker;
  if (!isId(trackId)) return { why: NO_SUCH_TRACK };
  const track = await getOwnedTrackSummary(db, { ownerUserId: userId, trackId });
  if (!track) {
    const title = await readableTrackTitle(asker, trackId);
    return {
      why:
        title === undefined
          ? NO_SUCH_TRACK
          : `The Track ${quoted(title)} is another user's: it plays inside the Playlist they share it in. Give that Playlist's id together with this Track's id.`,
    };
  }
  const name = quoted(track.title);
  if (track.dislikedAt || track.status === 'rejected' || track.status === 'deleted') {
    return { why: `The Track ${name} was removed and cannot be played.` };
  }
  const session = await getPlayableTrackSession(db, { ownerUserId: userId, trackId });
  if (!session) {
    return {
      why: `The Track ${name} cannot be started on its own: it has no audio yet, or the Session it came from is gone. If it is in a Playlist, give that Playlist's id together with this Track's id.`,
    };
  }
  if (player?.trackId === trackId && player.playing) {
    return { why: `The Track ${name} is already playing.` };
  }
  return {
    source: { kind: 'session', id: session.id, name: session.title },
    track: { id: trackId, name: track.title },
  };
}

/**
 * One of the asker's Sessions that Resume would bring back with something to
 * play. Resume itself refuses none, so the one Session turned down here is the
 * one that would sit silent: no Track left and no New Music to make one.
 */
async function resumableSession(asker: AssistantAsker, sessionId: string): Promise<Checked> {
  const { db, userId, player } = asker;
  const session = await ownSession(asker, sessionId);
  if (!session) return { why: NO_SUCH_SESSION };
  const name = quoted(session.title);
  if (player?.source.id === sessionId && player.playing) {
    return { why: `The Session ${name} is already playing.` };
  }
  if (session.sessionMode === 'repeat') {
    const tracks = await listSessionTracks(db, {
      ownerUserId: userId,
      sessionId,
      cursor: null,
      limit: 1,
    });
    if (!tracks?.items.length) {
      return {
        why: `The Session ${name} cannot be resumed: it has no Track left to play, and its New Music is off.`,
      };
    }
  }
  return { source: { kind: 'session', id: session.id, name: session.title } };
}

/** One Track of one of the asker's Sessions. */
async function trackOfSession(
  asker: AssistantAsker,
  sessionId: string,
  trackId: string,
): Promise<Checked> {
  const session = await ownSession(asker, sessionId);
  if (!session) return { why: NO_SUCH_SESSION };
  const found = await trackInItsSession(asker, trackId);
  if ('why' in found || found.source.id === sessionId) return found;
  return {
    why: `The Track ${quoted(found.track?.name ?? null)} is not in the Session ${quoted(session.title)}.`,
  };
}

/**
 * A Playlist the asker can see, with a member the browser's play flow can
 * start. Members are read as that flow reads them, a page of the size it asks
 * for: a Track to start at that lies past this page is left for the browser to
 * find.
 */
async function playablePlaylist(
  asker: AssistantAsker,
  playlistId: string,
  trackId: string | null,
): Promise<Checked> {
  if (!isId(playlistId)) return { why: NO_SUCH_PLAYLIST };
  const readable = await readablePlaylist(asker, playlistId, MAX_PLAYLIST_PAGE_LIMIT);
  if (!readable) return { why: NO_SUCH_PLAYLIST };
  const { playlist, nextCursor } = readable;
  const members = readable.items.map(toPlaylistMemberItem);
  const name = quoted(playlist.name);
  if (!members.some((member) => member.audioUrl !== null)) {
    return { why: `The Playlist ${name} has no Track that can be played.` };
  }
  const source: AssistantPlayCommand['source'] = {
    kind: 'playlist',
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.trackCount,
    foreign: playlist.ownerUserId !== asker.userId,
  };
  if (trackId === null) return { source };
  const member = members.find(({ id }) => id === trackId);
  if (!member) {
    const title = nextCursor === null ? undefined : await readableTrackTitle(asker, trackId);
    return title === undefined
      ? { why: `That Track is not in the Playlist ${name}.` }
      : { source, track: { id: trackId, name: title } };
  }
  if (member.audioUrl === null) {
    return { why: `The Track ${quoted(member.title)} has no audio that can be played.` };
  }
  return { source, track: { id: member.id, name: member.title } };
}

function checked(asker: AssistantAsker, { kind, id, trackId }: PlayInput): Promise<Checked> {
  switch (kind) {
    case 'session':
      return trackId ? trackOfSession(asker, id, trackId) : resumableSession(asker, id);
    case 'playlist':
      return playablePlaylist(asker, id, trackId || null);
    case 'track':
      return trackInItsSession(asker, id);
  }
}

export function createPlayTool(asker: AssistantAsker, actions: TurnActions): LlmTool<PlayInput> {
  return {
    name: PLAY_TOOL_NAME,
    description:
      "Plays music the user already has, in the player in their browser: resumes one of their Sessions, plays a Playlist, or starts one Track. It generates nothing by itself; a resumed Session keeps the user's New Music setting.",
    inputSchema: playInputSchema,
    execute: (input) =>
      actions.take('player', async () => {
        const play = await checked(asker, input);
        return 'why' in play ? refused(play.why) : handedOver({ name: 'play', ...play });
      }),
  };
}
