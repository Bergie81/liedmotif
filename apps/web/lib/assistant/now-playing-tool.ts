// `nowPlaying`: what the asking user is listening to. The player lives in the
// browser, so the request says what it has engaged; the server names it from
// its own records, and only as far as the asker may see it.

import { getActiveSession, getSessionById, type SessionRecord } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { isDurationTargetReached, noToolInputSchema, type NoToolInput } from '@liedmotif/shared';
import { sleepTimerMinutesLeft } from '@/components/player/sleep-timer';
import { named } from './music-names';
import { readablePlaylist, readableTrackTitle } from './readable-music';
import { NOW_PLAYING_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

/**
 * New Music as the player's status reads it: a reached duration target is
 * "finished", since the stored mode alone would say "on" for a Session that
 * generates nothing more.
 */
function newMusicLine(session: SessionRecord): string {
  if (session.sessionMode !== 'keep_going') return 'New Music: off';
  const target = session.targetDurationMinutes;
  if (target == null) return 'New Music: on, no duration target';
  const generated = Math.floor((session.generatedDurationSeconds ?? 0) / 60);
  return isDurationTargetReached(target, session.generatedDurationSeconds)
    ? `New Music: finished, the duration target of ${target} min is reached (${generated} min generated): no new Tracks generate until it is raised or cleared`
    : `New Music: on, duration target ${target} min (${generated} min generated)`;
}

function sessionLines(session: SessionRecord): string[] {
  return [
    `Session: ${named(session.title, session.id)}`,
    newMusicLine(session),
    ...(session.status === 'stopped'
      ? ['The Session is stopped: nothing is generated until it is resumed.']
      : []),
  ];
}

/** The Sleep Timer as the browser reported it; one that has run out is off. */
function sleepTimerLine(endsAt: number | undefined): string {
  const now = Date.now();
  const minutes = endsAt !== undefined && endsAt > now ? sleepTimerMinutesLeft(endsAt, now) : null;
  return minutes === null ? 'Sleep Timer: off' : `Sleep Timer: the music pauses in ${minutes} min`;
}

async function trackLine(
  asker: AssistantAsker,
  label: string,
  trackId: string | null,
): Promise<string[]> {
  if (!trackId) return [];
  const title = await readableTrackTitle(asker, trackId);
  return title === undefined ? [] : [`${label}: ${named(title, trackId)}`];
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
    sleepTimerLine(player.sleepTimerEndsAt),
    ...rest,
  ];
}

export function createNowPlayingTool(asker: AssistantAsker): LlmTool<NoToolInput> {
  return {
    name: NOW_PLAYING_TOOL_NAME,
    description:
      'What the user is listening to right now: the Session or Playlist, the current Track, whether it is playing or paused, how long a running Sleep Timer has left, and for a Session its New Music setting.',
    inputSchema: noToolInputSchema,
    async execute() {
      const engaged = await engagedLines(asker);
      if (engaged) return engaged.join('\n');
      // A player state the asker cannot see is still the player's: what it
      // names stays unnamed, and the player is not called idle either.
      const unnamed = asker.player
        ? `The player in this browser has something ${asker.player.playing ? 'playing' : 'paused'} that this user cannot open: it was removed, or it is no longer shared with them.`
        : null;
      const active = await getActiveSession(asker.db, { ownerUserId: asker.userId });
      if (!active) {
        return unnamed
          ? `${unnamed} There is no active Session.`
          : 'Nothing is playing, and there is no active Session.';
      }
      return [
        unnamed
          ? `${unnamed} The active Session:`
          : 'Nothing is playing in this browser. The active Session:',
        ...sessionLines(active),
        ...(await trackLine(asker, 'Last Track', active.currentTrackId)),
      ].join('\n');
    },
  };
}
