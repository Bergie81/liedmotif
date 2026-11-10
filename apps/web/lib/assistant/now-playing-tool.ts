// `nowPlaying`: what the asking user is listening to. The player lives in the
// browser, so the request says what it has engaged; the server names it from
// its own records, and only as far as the asker may see it.

import {
  getActiveSession,
  getReadableTrackDetails,
  getSessionById,
  type SessionRecord,
} from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { noToolInputSchema, type NoToolInput } from '@liedmotif/shared';
import { named } from './music-names';
import { readablePlaylist } from './readable-music';
import { NOW_PLAYING_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

function sessionLines(session: SessionRecord): string[] {
  const generated = Math.floor((session.generatedDurationSeconds ?? 0) / 60);
  const target =
    session.targetDurationMinutes == null
      ? 'no duration target'
      : `duration target ${session.targetDurationMinutes} min (${generated} min generated)`;
  return [
    `Session: ${named(session.title, session.id)}`,
    session.sessionMode === 'keep_going' ? `New music: on, ${target}` : 'New music: off',
    ...(session.status === 'stopped'
      ? ['The Session is stopped: nothing is generated until it is resumed.']
      : []),
  ];
}

async function trackLine(
  { db, userId }: AssistantAsker,
  label: string,
  trackId: string | null,
): Promise<string[]> {
  if (!trackId) return [];
  const track = await getReadableTrackDetails(db, { viewerUserId: userId, trackId });
  return track ? [`${label}: ${named(track.title, trackId)}`] : [];
}

/**
 * What the browser's player has engaged, or null when that is nothing the
 * asker can see: an id from the request is only ever a question to the
 * database, asked as this user.
 */
async function engagedLines(asker: AssistantAsker): Promise<string[] | null> {
  const { db, userId, player } = asker;
  if (!player) return null;
  let source: string[];
  if (player.source.kind === 'session') {
    const session = await getSessionById(db, {
      ownerUserId: userId,
      sessionId: player.source.id,
    });
    if (!session) return null;
    source = sessionLines(session);
  } else {
    const readable = await readablePlaylist(asker, player.source.id, 1);
    if (!readable) return null;
    source = [`Playlist: ${named(readable.playlist.name, player.source.id)}`];
  }
  const [first, ...rest] = source;
  return [
    first!,
    ...(await trackLine(asker, 'Track', player.trackId)),
    `Player: ${player.playing ? 'playing' : 'paused'}`,
    ...rest,
  ];
}

export function createNowPlayingTool(asker: AssistantAsker): LlmTool<NoToolInput> {
  return {
    name: NOW_PLAYING_TOOL_NAME,
    description:
      'What the user is listening to right now: the Session or Playlist, the current Track, whether it is playing or paused, and for a Session its New music setting.',
    inputSchema: noToolInputSchema,
    async execute() {
      const engaged = await engagedLines(asker);
      if (engaged) return engaged.join('\n');
      const active = await getActiveSession(asker.db, { ownerUserId: asker.userId });
      if (!active) return 'Nothing is playing, and there is no active Session.';
      return [
        'Nothing is playing in this browser. The active Session:',
        ...sessionLines(active),
        ...(await trackLine(asker, 'Last Track', active.currentTrackId)),
      ].join('\n');
    },
  };
}
