// The music an eval question is asked about: one small, fixed Library, one
// player state, and the tools of a turn answered from them. The model is
// offered the tools of a real turn, built by the app's own code, so their
// names, descriptions and input schemas are the real ones. Only what answers
// a call differs: a tool that would read the asking user's data answers from
// the Library below, and one that would change it, command the player or
// prepare a card reports what a real turn would report and changes nothing.
// The player has the active Session on, unless a question is asked with
// nothing playing.

import type { Database, UserRole } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  assistantCardSchema,
  isSungTheme,
  MAX_COVER_GUIDANCE_LENGTH,
  renameSessionRequestSchema,
  renameTrackRequestSchema,
  targetDurationMinutesSchema,
  type AddToPlaylistInput,
  type AssistantCard,
  type AssistantPlayCommand,
  type AssistantPlayerState,
  type AssistantSetting,
  type ChangeSettingInput,
  type CreatePlaylistInput,
  type FavoriteTrackInput,
  type FindMusicInput,
  type ListTracksInput,
  type PinPlaylistInput,
  type PinSessionInput,
  type PlayInput,
  type ProposeChangeVibeInput,
  type ProposeCoverInput,
  type ProposeMoreLikeThisInput,
  type ProposeNewMusicOnInput,
  type ProposeSessionInput,
  type ProposeSurpriseInput,
  type ReadTrackInput,
  type RenamePlaylistInput,
  type RenameSessionInput,
  type RenameTrackInput,
} from '@liedmotif/shared';
import { LIST_NAMES } from '../find-music-tool';
import {
  askedSource,
  askedTracks,
  done,
  NO_PLAYLIST_PLAYING,
  NO_SESSION_PLAYING,
  NO_SUCH_PLAYLIST,
  NO_SUCH_SESSION,
  NO_SUCH_TRACK,
  NO_TRACK_PLAYING,
  refused,
} from '../library-action';
import { BAD_SESSION_NAME } from '../manage-session-tools';
import { named, quoted, trackCount } from '../music-names';
import { handedOver, refused as leftAsItIs } from '../player-tools';
import { BAD_DURATION, notOffered, proposed } from '../proposal';
import { GUIDANCE_TOO_LONG } from '../propose-cover-tool';
import { BAD_TRACK_NAME } from '../rename-track-tool';
import {
  ADD_TO_PLAYLIST_TOOL_NAME,
  BUDGET_TOOL_NAME,
  CHANGE_SETTING_TOOL_NAME,
  CREATE_PLAYLIST_TOOL_NAME,
  FAVORITE_TRACK_TOOL_NAME,
  FIND_MUSIC_TOOL_NAME,
  LIST_TRACKS_TOOL_NAME,
  NEW_MUSIC_OFF_TOOL_NAME,
  NOW_PLAYING_TOOL_NAME,
  PIN_PLAYLIST_TOOL_NAME,
  PIN_SESSION_TOOL_NAME,
  PLAY_TOOL_NAME,
  PROPOSE_CHANGE_VIBE_TOOL_NAME,
  PROPOSE_COVER_TOOL_NAME,
  PROPOSE_MORE_LIKE_THIS_TOOL_NAME,
  PROPOSE_NEW_MUSIC_ON_TOOL_NAME,
  PROPOSE_SESSION_TOOL_NAME,
  PROPOSE_SURPRISE_TOOL_NAME,
  READ_TRACK_TOOL_NAME,
  RENAME_PLAYLIST_TOOL_NAME,
  RENAME_SESSION_TOOL_NAME,
  RENAME_TRACK_TOOL_NAME,
} from '../tool-names';
import { createAssistantTools } from '../tools';
import type { TurnActions } from '../turn-actions';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

interface FixtureSession {
  id: string;
  title: string;
  /** When it was last listened to, as `findMusic` words it. */
  lastActive: string;
  /** What the user asked for, and the style the music model received: its Tracks' Track Data. */
  prompt: string;
  style: string;
  genres: readonly string[];
}

interface FixtureTrack {
  id: string;
  title: string;
  /** The Session it was generated in, which is what plays it. */
  session: FixtureSession;
  length: string;
  /** Its sung lines; an instrumental has none. */
  lyrics?: string;
}

interface FixturePlaylist {
  id: string;
  name: string;
  tracks: readonly FixtureTrack[];
  /** Favorites: it keeps its name. */
  system?: true;
}

/** Night Drive is the active Session: New Music on, up to 60 minutes, 40 of them generated. */
export const SESSIONS = {
  nightDrive: {
    id: id(101),
    title: 'Night Drive',
    lastActive: 'active now',
    prompt: 'music for driving through the city at night',
    style: 'synthwave, analog synths, pulsing bass, female vocals, 100 bpm',
    genres: ['synthwave', 'retrowave'],
  },
  morningFocus: {
    id: id(102),
    title: 'Morning Focus',
    lastActive: 'last active 2 days ago',
    prompt: 'calm music to focus in the morning',
    style: 'ambient piano, soft pads, instrumental, 70 bpm',
    genres: ['ambient', 'neoclassical'],
  },
  tempoRun: {
    id: id(103),
    title: 'Tempo Run',
    lastActive: 'last active 5 days ago',
    prompt: 'fast music for a tempo run',
    style: 'drum and bass, rolling breaks, instrumental, 174 bpm',
    genres: ['drum and bass'],
  },
  seasideSongs: {
    id: id(104),
    title: 'Seaside Songs',
    lastActive: 'last active 9 days ago',
    prompt: 'songs about the sea',
    style: 'indie folk, acoustic guitar, warm vocals, 90 bpm',
    genres: ['indie folk'],
  },
} satisfies Record<string, FixtureSession>;

export const TRACKS = {
  neonRain: {
    id: id(201),
    title: 'Neon Rain',
    session: SESSIONS.nightDrive,
    length: '3:12',
    lyrics: 'City lights in the neon rain\nWe drive till the morning comes again',
  },
  midnightOverpass: {
    id: id(202),
    title: 'Midnight Overpass',
    session: SESSIONS.nightDrive,
    length: '2:58',
  },
  tailLights: { id: id(203), title: 'Tail Lights', session: SESSIONS.nightDrive, length: '3:40' },
  firstLight: { id: id(204), title: 'First Light', session: SESSIONS.morningFocus, length: '4:05' },
  quietDesk: { id: id(205), title: 'Quiet Desk', session: SESSIONS.morningFocus, length: '3:31' },
  stride: { id: id(206), title: 'Stride', session: SESSIONS.tempoRun, length: '2:47' },
  secondWind: { id: id(207), title: 'Second Wind', session: SESSIONS.tempoRun, length: '3:03' },
  harbourLights: {
    id: id(208),
    title: 'Harbour Lights',
    session: SESSIONS.seasideSongs,
    length: '3:26',
    lyrics: 'We watched the harbour lights go out, one by one',
  },
  papierboote: {
    id: id(209),
    title: 'Papierboote',
    session: SESSIONS.seasideSongs,
    length: '2:51',
    lyrics: 'Papierboote treiben auf der Morgenflut',
  },
} satisfies Record<string, FixtureTrack>;

/** Road Trip is empty: a Playlist the user has only just created. */
export const PLAYLISTS = {
  favorites: {
    id: id(301),
    name: 'Favorites',
    tracks: [TRACKS.midnightOverpass, TRACKS.harbourLights],
    system: true,
  },
  running: {
    id: id(302),
    name: 'Running',
    tracks: [TRACKS.stride, TRACKS.secondWind, TRACKS.tailLights],
  },
  sundayMorning: {
    id: id(303),
    name: 'Sunday Morning',
    tracks: [TRACKS.firstLight, TRACKS.quietDesk, TRACKS.papierboote],
  },
  roadTrip: { id: id(304), name: 'Road Trip', tracks: [] },
} satisfies Record<string, FixturePlaylist>;

const ACTIVE = SESSIONS.nightDrive;
const HOW_LONG =
  'A new Session needs a length in minutes, or no limit. Ask the user how long it should run.';
const ACTIVE_TARGET_MINUTES = 60;
const ACTIVE_GENERATED_MINUTES = 40;

/** The id a Playlist created during a question gets. The fixture never holds it. */
const CREATED_PLAYLIST_ID = id(399);

/** What the browser's player has engaged when a question is asked: "this" is Neon Rain. */
const PLAYING: AssistantPlayerState = {
  source: { kind: 'session', id: ACTIVE.id },
  trackId: TRACKS.neonRain.id,
  playing: true,
};

const sessions: readonly FixtureSession[] = Object.values(SESSIONS);
const tracks: readonly FixtureTrack[] = Object.values(TRACKS);
const playlists: readonly FixturePlaylist[] = Object.values(PLAYLISTS);

/** The fixture in one sentence, for whoever reads a report. */
export const FIXTURE_SUMMARY = `a fixed Library of ${trackCount(tracks.length)} in ${sessions.length} Sessions and ${playlists.length} Playlists, with the Session ${quoted(ACTIVE.title)} active and its Track ${quoted(TRACKS.neonRain.title)} playing`;

const sessionById = (sessionId: string) => sessions.find((session) => session.id === sessionId);
const trackById = (trackId: string) => tracks.find((track) => track.id === trackId);
const playlistById = (playlistId: string) =>
  playlists.find((playlist) => playlist.id === playlistId);
const tracksOf = (session: FixtureSession) => tracks.filter((track) => track.session === session);

const item = ({ id: itemId, title }: { id: string; title: string }) => ({
  id: itemId,
  name: title,
});

const BUDGET: Record<UserRole, string> = {
  member: [
    'Your budget: 12 of 20 Tracks left today, 68 of 100 Tracks left this month. 7 of 10 covers left today, 19 of 25 covers left this month.',
    'Shared budget of all Members: 41 of 60 Tracks left today, 230 of 300 Tracks left this month. 22 of 30 covers left today, 81 of 100 covers left this month.',
    'New Music and covers are generated only while both budgets have some left.',
  ].join('\n'),
  admin:
    'Instance limit: 34 of 50 Tracks left today, 412 of 500 Tracks left this month. 9 of 10 covers left today, 37 of 60 covers left this month.',
};

function nowPlaying(player: AssistantPlayerState | null): string {
  const newMusic = `New Music: on, duration target ${ACTIVE_TARGET_MINUTES} min (${ACTIVE_GENERATED_MINUTES} min generated)`;
  if (!player) {
    return [
      'Nothing is playing in this browser. The active Session:',
      `Session: ${named(ACTIVE.title, ACTIVE.id)}`,
      newMusic,
    ].join('\n');
  }
  const track = trackById(player.trackId ?? '');
  return [
    `Session: ${named(ACTIVE.title, ACTIVE.id)}`,
    ...(track ? [`Track: ${named(track.title, track.id)}`] : []),
    `Player: ${player.playing ? 'playing' : 'paused'}`,
    'Sleep Timer: off',
    newMusic,
  ].join('\n');
}

/** A Track as the real `readTrack` words it, from what the fixture knows of it. */
function readTrack({ trackId }: ReadTrackInput, player: AssistantPlayerState | null): string {
  const askedId = trackId || player?.trackId;
  if (!askedId) return NO_TRACK_PLAYING;
  const track = trackById(askedId);
  if (!track) return NO_SUCH_TRACK;
  const { session } = track;
  return [
    `Track ${named(track.title, track.id)}`,
    `Title: ${track.title}`,
    `Session: ${session.title}`,
    `Duration: ${track.length}`,
    `User's prompt: ${session.prompt}`,
    `Style prompt: ${session.style}`,
    `Genres: ${session.genres.join(', ')}`,
    `Vocals: ${track.lyrics ? 'Vocal' : 'Instrumental'}`,
    track.lyrics ? `Lyrics:\n${track.lyrics}` : 'Lyrics: none, it is instrumental.',
  ].join('\n');
}

const sessionRow = ({ id: sessionId, title, lastActive }: FixtureSession) =>
  `${named(title, sessionId)} · ${lastActive}`;
const playlistRow = ({ id: playlistId, name, tracks: members }: FixturePlaylist) =>
  `${named(name, playlistId)} · ${trackCount(members.length)}`;
const trackRow = ({ id: trackId, title, session }: FixtureTrack) =>
  `${named(title, trackId)} · Session ${quoted(session.title)}`;

/**
 * The rows whose text holds a word of the query, the ones that hold more of
 * its words first. A word counts by its first letters, so "Papierbooten"
 * finds "Papierboote": a stand-in for the app's search, not a copy of it.
 */
function matching<Row>(rows: readonly Row[], query: string, text: (row: Row) => string): Row[] {
  const stems = (query.toLowerCase().match(/\p{L}{3,}/gu) ?? []).map((word) => word.slice(0, 5));
  const hits = (row: Row) => stems.filter((stem) => text(row).toLowerCase().includes(stem)).length;
  return rows.filter((row) => hits(row) > 0).sort((a, b) => hits(b) - hits(a));
}

const listed = (heading: string, rows: readonly string[], none: string) =>
  rows.length === 0 ? none : [heading, ...rows.map((row) => `- ${row}`)].join('\n');

function findMusic({ kind, query, lyrics, list }: FindMusicInput): string {
  const words = (query ?? '').trim();
  const text = quoted(words);
  if (lyrics) {
    return listed(
      `Tracks with ${text} in their lyrics:`,
      matching(tracks, words, (track) => track.lyrics ?? '').map(
        (track) => `${trackRow(track)} · lyrics: ${quoted(track.lyrics ?? '')}`,
      ),
      `No Track has ${text} in its lyrics.`,
    );
  }
  if (kind === 'track') {
    if (words) {
      return listed(
        `Tracks matching ${text}:`,
        matching(tracks, words, ({ title, session }) => `${title} ${session.title}`).map(trackRow),
        `No Track matches ${text}.`,
      );
    }
    const inList =
      list === 'favorites'
        ? PLAYLISTS.favorites.tracks
        : list === 'saved'
          ? tracks.filter((track) => playlists.some((playlist) => playlist.tracks.includes(track)))
          : tracks;
    const name = LIST_NAMES[list ?? 'history'];
    return listed(
      `Tracks in ${name}, most recent first:`,
      inList.map(trackRow),
      `There are no Tracks in ${name}.`,
    );
  }
  if (kind === 'playlist') {
    return words
      ? listed(
          `Playlists matching ${text}:`,
          matching(playlists, words, ({ name }) => name).map(playlistRow),
          `No Playlist matches ${text}.`,
        )
      : listed(
          'Playlists, in the order the Library lists them:',
          playlists.map(playlistRow),
          'There are no Playlists yet.',
        );
  }
  return words
    ? listed(
        `Sessions matching ${text}:`,
        matching(sessions, words, ({ title }) => title).map(sessionRow),
        `No Session matches ${text}.`,
      )
    : listed(
        'Sessions, most recent first:',
        sessions.map(sessionRow),
        'There are no Sessions yet.',
      );
}

function listTracks({ in: where, id: listId }: ListTracksInput): string {
  const kind = where === 'session' ? 'Session' : 'Playlist';
  const session = where === 'session' ? sessionById(listId) : undefined;
  const playlist = where === 'playlist' ? playlistById(listId) : undefined;
  const members = session ? tracksOf(session) : playlist?.tracks;
  if (!members) return `No ${kind} with that id.`;
  const heading = `${kind} ${named(session?.title ?? playlist?.name ?? null, listId)}`;
  if (members.length === 0) return `${heading} has no Tracks.`;
  return [
    `${heading}, ${trackCount(members.length)} in order:`,
    ...members.map(
      ({ id: trackId, title, length }, index) =>
        `${index + 1}. ${named(title, trackId)} · ${length}`,
    ),
  ].join('\n');
}

/** What a play command starts, or why the fixture has nothing to hand over. */
function playable({
  kind,
  id: playId,
  trackId,
}: PlayInput): Pick<AssistantPlayCommand, 'source' | 'track'> | { why: string } {
  if (kind === 'track') {
    const track = trackById(playId);
    return track
      ? { source: { kind: 'session', ...item(track.session) }, track: item(track) }
      : { why: NO_SUCH_TRACK };
  }
  const session = kind === 'session' ? sessionById(playId) : undefined;
  const playlist = kind === 'playlist' ? playlistById(playId) : undefined;
  const members = session ? tracksOf(session) : playlist?.tracks;
  if (!members) return { why: `No ${kind === 'session' ? 'Session' : 'Playlist'} with that id.` };
  if (members.length === 0) return { why: 'It has no Track that can be played.' };
  const source: AssistantPlayCommand['source'] = session
    ? { kind: 'session', ...item(session) }
    : {
        kind: 'playlist',
        id: playlist!.id,
        name: playlist!.name,
        trackCount: members.length,
        foreign: false,
      };
  if (!trackId) return { source };
  const track = members.find((member) => member.id === trackId);
  return track ? { source, track: item(track) } : { why: 'That Track is not in it.' };
}

/**
 * The Surprise Me suggestion a fixture turn prepares, whatever was asked of
 * it but its vocals: the app's comes from the text LLM and the user's taste,
 * which the fixture has neither of.
 */
function surpriseSuggestion({
  adventurous,
  theme,
  vocal,
}: ProposeSurpriseInput): Extract<AssistantCard, { kind: 'surprise' }>['suggestion'] {
  const sung = (theme != null && isSungTheme(theme)) || vocal === 'vocal';
  return {
    id: id(401),
    adventurous: adventurous ?? false,
    title: 'Open Windows',
    mood: 'bright and unhurried',
    genres: ['downtempo', 'nu jazz'],
    energy: 'medium',
    vocalMode: sung ? 'vocal' : 'instrumental',
    voiceGender: sung ? 'female' : null,
    language: sung ? 'English' : null,
  };
}

/** How long a Surprise Me suggestion runs when the user named no length. */
const SURPRISE_MINUTES = 45;

/** The fixture user's settings before a turn, each as its settings page shows it. */
const SETTINGS: Record<AssistantSetting, string> = {
  ownerInCovers: 'Always',
  blend: 'On',
  crossfadeSeconds: '6 s',
  defaultLanguage: 'Auto Detect',
};

/** How a fixture turn answers one tool, in place of that tool's own code. */
type Answer = (input: never) => Promise<string>;

/**
 * The fixture's answer for every tool that would reach the database. The tools
 * left out answer as in the app: the docs tool reads the real docs snapshot,
 * and the two player tools decide from the player state alone.
 */
function fixtureAnswers(
  role: UserRole,
  actions: TurnActions,
  player: AssistantPlayerState | null,
): Record<string, Answer> {
  return {
    [NOW_PLAYING_TOOL_NAME]: async () => nowPlaying(player),
    [BUDGET_TOOL_NAME]: async () => BUDGET[role],
    [FIND_MUSIC_TOOL_NAME]: async (input: FindMusicInput) => findMusic(input),
    [LIST_TRACKS_TOOL_NAME]: async (input: ListTracksInput) => listTracks(input),
    [READ_TRACK_TOOL_NAME]: async (input: ReadTrackInput) => readTrack(input, player),

    [FAVORITE_TRACK_TOOL_NAME]: ({ trackId }: FavoriteTrackInput) =>
      actions.take('done', async () => {
        const askedId = trackId || player?.trackId;
        if (!askedId) return refused(NO_TRACK_PLAYING);
        const track = trackById(askedId);
        if (!track) return refused(NO_SUCH_TRACK);
        const { id: playlistId, name } = PLAYLISTS.favorites;
        return done({
          action: 'favoriteTrack',
          track: item(track),
          playlist: { id: playlistId, name },
        });
      }),
    [ADD_TO_PLAYLIST_TOOL_NAME]: ({ playlistId, trackIds }: AddToPlaylistInput) =>
      actions.take('done', async () => {
        const playlist = playlistById(playlistId);
        if (!playlist) return refused(NO_SUCH_PLAYLIST);
        const added = askedTracks(trackIds, player).flatMap((trackId) => trackById(trackId) ?? []);
        if (added.length === 0) {
          return refused(`No Track was added to ${named(playlist.name, playlist.id)}.`);
        }
        return done({
          action: 'addToPlaylist',
          playlist: { id: playlist.id, name: playlist.name },
          retention: playlist.system ? 'favorite' : 'curated',
          tracks: added.map(item),
        });
      }),
    [CREATE_PLAYLIST_TOOL_NAME]: ({ name }: CreatePlaylistInput) =>
      actions.take('done', async () =>
        name.trim()
          ? done({
              action: 'createPlaylist',
              playlist: { id: CREATED_PLAYLIST_ID, name: name.trim() },
            })
          : refused('A Playlist needs a name.'),
      ),
    [RENAME_PLAYLIST_TOOL_NAME]: ({ playlistId, name }: RenamePlaylistInput) =>
      actions.take('done', async () => {
        const playlist = playlistById(playlistId);
        if (!playlist) return refused(NO_SUCH_PLAYLIST);
        if (playlist.system) return refused('Favorites cannot be renamed.');
        if (!name.trim()) return refused('A Playlist needs a name.');
        return done({
          action: 'renamePlaylist',
          playlist: { id: playlist.id, name: name.trim() },
          previousName: playlist.name,
        });
      }),
    [PIN_PLAYLIST_TOOL_NAME]: ({ playlistId }: PinPlaylistInput) =>
      actions.take('done', async () => {
        const playlist = playlistById(playlistId);
        if (!playlist) return refused(NO_SUCH_PLAYLIST);
        if (playlist.system) return refused('That Playlist cannot be pinned.');
        return done({
          action: 'pinPlaylist',
          playlist: { id: playlist.id, name: playlist.name },
        });
      }),
    [RENAME_SESSION_TOOL_NAME]: ({ sessionId, name }: RenameSessionInput) =>
      actions.take('done', async () => {
        const title = renameSessionRequestSchema.shape.title.safeParse(name);
        if (!title.success) return refused(BAD_SESSION_NAME);
        const askedId = askedSource('session', sessionId, player);
        if (!askedId) return refused(NO_SESSION_PLAYING);
        const session = sessionById(askedId);
        if (!session) return refused(NO_SUCH_SESSION);
        return done({
          action: 'renameSession',
          session: { id: session.id, name: title.data },
          previousName: session.title,
        });
      }),
    [PIN_SESSION_TOOL_NAME]: ({ sessionId }: PinSessionInput) =>
      actions.take('done', async () => {
        const askedId = askedSource('session', sessionId, player);
        if (!askedId) return refused(NO_SESSION_PLAYING);
        const session = sessionById(askedId);
        if (!session) return refused(NO_SUCH_SESSION);
        return done({ action: 'pinSession', session: item(session) });
      }),
    [RENAME_TRACK_TOOL_NAME]: ({ trackId, name }: RenameTrackInput) =>
      actions.take('done', async () => {
        const title = renameTrackRequestSchema.shape.title.safeParse(name);
        if (!title.success) return refused(BAD_TRACK_NAME);
        const askedId = trackId || player?.trackId;
        if (!askedId) return refused(NO_TRACK_PLAYING);
        const track = trackById(askedId);
        if (!track) return refused(NO_SUCH_TRACK);
        return done({
          action: 'renameTrack',
          track: { id: track.id, name: title.data },
          previousName: track.title,
        });
      }),
    [NEW_MUSIC_OFF_TOOL_NAME]: () =>
      actions.take('done', async () => done({ action: 'newMusicOff', session: item(ACTIVE) })),
    // Whatever choice the model names is taken as stored: the fixture has no settings to hold it.
    [CHANGE_SETTING_TOOL_NAME]: ({ setting, value }: ChangeSettingInput) =>
      actions.take('done', async () =>
        done({ action: 'changeSetting', setting, value, previous: SETTINGS[setting] }),
      ),

    [PLAY_TOOL_NAME]: (input: PlayInput) =>
      actions.take('player', async () => {
        const play = playable(input);
        return 'why' in play ? leftAsItIs(play.why) : handedOver({ name: 'play', ...play });
      }),

    [PROPOSE_SESSION_TOOL_NAME]: ({
      prompt,
      vocal,
      targetDurationMinutes: minutes,
      noLimit,
    }: ProposeSessionInput) =>
      actions.take('proposed', async () => {
        if (minutes == null && !noLimit) return notOffered(HOW_LONG);
        const card = assistantCardSchema.safeParse({
          kind: 'session',
          prompt: prompt.trim(),
          vocal: vocal ? 'vocal' : 'instrumental',
          targetDurationMinutes: minutes ?? null,
        });
        return card.success
          ? proposed(card.data)
          : notOffered('A Session starts from a description, and runs 1 to 600 minutes.');
      }),
    [PROPOSE_CHANGE_VIBE_TOOL_NAME]: ({ prompt }: ProposeChangeVibeInput) =>
      actions.take('proposed', async () => {
        const card = assistantCardSchema.safeParse({
          kind: 'changeVibe',
          session: item(ACTIVE),
          prompt: prompt.trim(),
        });
        return card.success
          ? proposed(card.data)
          : notOffered('A Change Vibe needs what should change.');
      }),
    // The length rule of the fixture's proposeSession: its user's new Sessions keep going.
    [PROPOSE_MORE_LIKE_THIS_TOOL_NAME]: ({
      trackIds,
      targetDurationMinutes: minutes,
      noLimit,
    }: ProposeMoreLikeThisInput) =>
      actions.take('proposed', async () => {
        const asked = askedTracks(trackIds, player);
        const seeds = asked.flatMap((trackId) => trackById(trackId) ?? []);
        if (seeds.length === 0 || seeds.length < asked.length) return notOffered(NO_SUCH_TRACK);
        if (minutes == null && !noLimit) return notOffered(HOW_LONG);
        if (minutes != null && !targetDurationMinutesSchema.safeParse(minutes).success) {
          return notOffered(BAD_DURATION);
        }
        const card = assistantCardSchema.safeParse({
          kind: 'moreLikeThis',
          tracks: seeds.map(item),
          targetDurationMinutes: minutes ?? null,
        });
        return card.success ? proposed(card.data) : notOffered(NO_SUCH_TRACK);
      }),
    [PROPOSE_NEW_MUSIC_ON_TOOL_NAME]: ({
      targetDurationMinutes: minutes,
      noLimit,
    }: ProposeNewMusicOnInput) =>
      actions.take('proposed', async () => {
        const card = assistantCardSchema.safeParse({
          kind: 'newMusicOn',
          session: item(ACTIVE),
          targetDurationMinutes: noLimit ? null : minutes,
        });
        return (minutes == null) !== !noLimit && card.success
          ? proposed(card.data)
          : notOffered(
              'New Music is switched on up to a length in minutes, or with no limit: one of the two. Ask the user which they want.',
            );
      }),
    // The fixture user's new Sessions start with New Music on, so no limit is always offered.
    [PROPOSE_SURPRISE_TOOL_NAME]: (input: ProposeSurpriseInput) =>
      actions.take('proposed', async () => {
        const minutes = input.targetDurationMinutes;
        if (minutes != null && !targetDurationMinutesSchema.safeParse(minutes).success) {
          return notOffered(BAD_DURATION);
        }
        return proposed({
          kind: 'surprise',
          suggestion: surpriseSuggestion(input),
          targetDurationMinutes: minutes ?? (input.noLimit ? null : SURPRISE_MINUTES),
        });
      }),
    [PROPOSE_COVER_TOOL_NAME]: ({ in: kind, id: givenId, guidance }: ProposeCoverInput) =>
      actions.take('proposed', async () => {
        const words = guidance?.trim() || undefined;
        if (words && words.length > MAX_COVER_GUIDANCE_LENGTH) {
          return notOffered(GUIDANCE_TOO_LONG);
        }
        const askedId = askedSource(kind, givenId, player);
        if (!askedId) {
          return notOffered(kind === 'session' ? NO_SESSION_PLAYING : NO_PLAYLIST_PLAYING);
        }
        const session = kind === 'session' ? sessionById(askedId) : undefined;
        const playlist = kind === 'playlist' ? playlistById(askedId) : undefined;
        const subject = session
          ? { kind, ...item(session) }
          : playlist && { kind, id: playlist.id, name: playlist.name };
        if (!subject) return notOffered(kind === 'session' ? NO_SUCH_SESSION : NO_SUCH_PLAYLIST);
        return proposed({ kind: 'cover', subject, ...(words ? { guidance: words } : {}) });
      }),
  };
}

/**
 * The tools of ONE eval turn, asked by a user of `role`. They are a real
 * turn's tools: the app's own code builds them, for an asker with the fixture
 * player and no database, and each answer above takes the place of one tool's
 * own. `actions` counts and caps what the turn does, as in the app. A fixture
 * answer does not count against the turn's read budget, which the docs tool
 * keeps: the whole Library reads in under a thousand characters.
 */
export function fixtureTools(
  role: UserRole,
  actions: TurnActions,
  { nothingPlaying = false }: { nothingPlaying?: boolean } = {},
): LlmTool[] {
  const player = nothingPlaying ? null : PLAYING;
  const answers = fixtureAnswers(role, actions, player);
  const asker = { db: null as unknown as Database, userId: id(1), role, player };
  return createAssistantTools(asker, actions).map((tool) => {
    const answer = answers[tool.name];
    return answer ? { ...tool, execute: answer as LlmTool['execute'] } : tool;
  });
}
