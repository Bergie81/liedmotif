// The eval's stand-in for the asking user's music. It has to offer the model
// exactly what a real turn offers, answer every call without a database, and
// leave nothing changed: what a tool did is only ever reported.

import { describe, expect, it } from 'vitest';
import type { AssistantAction } from '@liedmotif/shared';
import { createAssistantTools } from '../tools';
import { createTurnActions } from '../turn-actions';
import { fixtureTools, PLAYLISTS, SESSIONS, TRACKS } from './fixture';

/** One fixture turn: its tools by name, and the actions it reported. */
function openTurn(role: 'admin' | 'member' = 'member') {
  const reported: AssistantAction[] = [];
  const tools = fixtureTools(
    role,
    createTurnActions((action) => reported.push(action)),
  );
  const call = (name: string, input: unknown = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool "${name}"`);
    return tool.execute(tool.inputSchema.parse(input));
  };
  return { tools, reported, call };
}

/** One call per tool that a real turn would answer from the database or the player. */
const VALID_CALLS: Record<string, unknown> = {
  readDocs: { page: 'members', section: 'intro' },
  nowPlaying: {},
  budget: {},
  findMusic: { kind: 'playlist' },
  listTracks: { in: 'playlist', id: PLAYLISTS.running.id },
  favoriteTrack: {},
  addToPlaylist: { playlistId: PLAYLISTS.running.id },
  createPlaylist: { name: 'Gym' },
  renamePlaylist: { playlistId: PLAYLISTS.running.id, name: 'Tempo' },
  pinPlaylist: { playlistId: PLAYLISTS.running.id },
  newMusicOff: {},
  play: { kind: 'playlist', id: PLAYLISTS.running.id },
  playerControl: { command: 'next' },
  sleepTimer: { minutes: 30 },
  proposeSession: { prompt: 'calm piano for reading' },
  proposeChangeVibe: { prompt: 'slower' },
  proposeMoreLikeThis: {},
  proposeNewMusicOn: { noLimit: true },
};

describe('the tools of a fixture turn', () => {
  it('are the tools of a real turn: same names, descriptions and input schemas', () => {
    const real = createAssistantTools(
      { db: {} as never, userId: 'user-1', role: 'member', player: null },
      createTurnActions(() => {}),
    );

    const { tools } = openTurn('member');

    expect(tools.map(({ name }) => name)).toEqual(real.map(({ name }) => name));
    expect(tools.map(({ description }) => description)).toEqual(
      real.map(({ description }) => description),
    );
    tools.forEach((tool, index) => expect(tool.inputSchema).toBe(real[index]!.inputSchema));
  });

  it('answer every call without a database', async () => {
    const { tools, call } = openTurn();

    expect(Object.keys(VALID_CALLS)).toEqual(tools.map(({ name }) => name));
    for (const [name, input] of Object.entries(VALID_CALLS)) {
      // What a real turn tells the model when a tool threw.
      expect(await openTurn().call(name, input), name).not.toMatch(/^That could not be/);
    }
    expect(await call('readDocs', VALID_CALLS.readDocs)).not.toMatch(/has no (page|section)/);
  });
});

describe('the read tools of a fixture turn', () => {
  it('name what the fixture player has engaged', async () => {
    const playing = await openTurn().call('nowPlaying');

    expect(playing).toContain(`Session: "Night Drive" (id ${SESSIONS.nightDrive.id})`);
    expect(playing).toContain(`Track: "Neon Rain" (id ${TRACKS.neonRain.id})`);
    expect(playing).toContain('Player: playing');
  });

  it("tell a Member their own budget and the Admin the instance's", async () => {
    expect(await openTurn('member').call('budget')).toMatch(/^Your budget: \d+ of \d+ Tracks left/);
    expect(await openTurn('admin').call('budget')).toMatch(/^Instance limit: \d+ of \d+ Tracks/);
  });

  it('find a Playlist by a word of its name, with the id the other tools take', async () => {
    const found = await openTurn().call('findMusic', { kind: 'playlist', query: 'my running' });

    expect(found).toContain(`"Running" (id ${PLAYLISTS.running.id})`);
    expect(found).not.toContain('Sunday Morning');
  });

  it('find a Track by a line of its lyrics, and show the line', async () => {
    const found = await openTurn().call('findMusic', {
      kind: 'track',
      query: 'Papierbooten',
      lyrics: true,
    });

    expect(found).toContain(`"Papierboote" (id ${TRACKS.papierboote.id})`);
    expect(found).toContain(TRACKS.papierboote.lyrics);
    expect(found).not.toContain('Neon Rain');
  });

  it('list the most recent when no query is given, and say so when nothing matches', async () => {
    const { call } = openTurn();

    expect(await call('findMusic', { kind: 'session' })).toContain('"Morning Focus"');
    expect(await call('findMusic', { kind: 'track', list: 'favorites' })).toMatch(
      /^Tracks in Favorites, most recent first:\n- "Midnight Overpass"/,
    );
    expect(await call('findMusic', { kind: 'track', query: 'zither' })).toBe(
      'No Track matches "zither".',
    );
  });

  it('list the Tracks of a Session in order, and know no other id', async () => {
    const { call } = openTurn();

    const listed = await call('listTracks', { in: 'session', id: SESSIONS.nightDrive.id });

    expect(listed.indexOf('Neon Rain')).toBeGreaterThan(-1);
    expect(listed.indexOf('Neon Rain')).toBeLessThan(listed.indexOf('Midnight Overpass'));
    expect(await call('listTracks', { in: 'session', id: PLAYLISTS.running.id })).toBe(
      'No Session with that id.',
    );
  });
});

describe('the tools of a fixture turn that act', () => {
  it('report a receipt for a Library action, worded as the app words it', async () => {
    const { call, reported } = openTurn();

    const told = await call('favoriteTrack', { trackId: TRACKS.harbourLights.id });

    expect(told).toBe(
      `Done: added the Track "Harbour Lights" (id ${TRACKS.harbourLights.id}) to Favorites.`,
    );
    expect(reported).toEqual([
      {
        status: 'done',
        receipt: {
          action: 'favoriteTrack',
          track: { id: TRACKS.harbourLights.id, name: 'Harbour Lights' },
          playlist: { id: PLAYLISTS.favorites.id, name: 'Favorites' },
        },
      },
    ]);
  });

  it('take the Track that is playing for "this"', async () => {
    const { call, reported } = openTurn();

    await call('addToPlaylist', { playlistId: PLAYLISTS.roadTrip.id });
    await call('proposeMoreLikeThis');

    expect(reported).toMatchObject([
      { receipt: { action: 'addToPlaylist', tracks: [{ id: TRACKS.neonRain.id }] } },
      { card: { kind: 'moreLikeThis', tracks: [{ id: TRACKS.neonRain.id, name: 'Neon Rain' }] } },
    ]);
  });

  it('refuse an id the fixture does not hold, and report nothing', async () => {
    const { call, reported } = openTurn();
    const unknown = '00000000-0000-4000-8000-00000000dead';

    expect(await call('favoriteTrack', { trackId: unknown })).toBe(
      'No Track with that id. Nothing was changed.',
    );
    expect(await call('pinPlaylist', { playlistId: unknown })).toMatch(/Nothing was changed\.$/);
    expect(await call('play', { kind: 'session', id: unknown })).toMatch(
      /The player was left as it is\.$/,
    );
    expect(reported).toEqual([]);
  });

  it('change nothing: the Library reads the same after an action', async () => {
    const { call } = openTurn();
    const before = await call('listTracks', { in: 'playlist', id: PLAYLISTS.running.id });

    await call('addToPlaylist', {
      playlistId: PLAYLISTS.running.id,
      trackIds: [TRACKS.harbourLights.id],
    });
    await call('renamePlaylist', { playlistId: PLAYLISTS.running.id, name: 'Tempo' });

    expect(await call('listTracks', { in: 'playlist', id: PLAYLISTS.running.id })).toBe(before);
  });

  it('hand the player a play command for a Session, a Playlist and a Track', async () => {
    const { call, reported } = openTurn();

    await call('play', { kind: 'session', id: SESSIONS.morningFocus.id });
    await call('play', { kind: 'playlist', id: PLAYLISTS.running.id });

    expect(reported).toEqual([
      {
        status: 'player',
        command: {
          name: 'play',
          source: { kind: 'session', id: SESSIONS.morningFocus.id, name: 'Morning Focus' },
        },
      },
      {
        status: 'player',
        command: {
          name: 'play',
          source: {
            kind: 'playlist',
            id: PLAYLISTS.running.id,
            name: 'Running',
            trackCount: PLAYLISTS.running.tracks.length,
            foreign: false,
          },
        },
      },
    ]);

    const track = openTurn();
    await track.call('play', { kind: 'track', id: TRACKS.harbourLights.id });
    expect(track.reported).toMatchObject([
      {
        command: {
          name: 'play',
          source: { kind: 'session', id: SESSIONS.seasideSongs.id },
          track: { id: TRACKS.harbourLights.id, name: 'Harbour Lights' },
        },
      },
    ]);
  });

  it('run the real player tools against the fixture player', async () => {
    const { call, reported } = openTurn();

    expect(await call('playerControl', { command: 'pause' })).toBe(
      'Done: the player was told to pause the music.',
    );
    // The fixture player is playing, so the real tool turns this one down.
    expect(await call('playerControl', { command: 'continue' })).toMatch(/already playing/);
    expect(reported).toEqual([{ status: 'player', command: { name: 'pause' } }]);
  });

  it('prepare a card for each thing that can spend', async () => {
    const { call, reported } = openTurn();

    const told = await call('proposeSession', {
      prompt: 'calm piano for reading',
      targetDurationMinutes: 45,
    });

    expect(told).toMatch(/^Prepared: a card to start a new Session from "calm piano for reading"/);
    expect(reported).toEqual([
      {
        status: 'proposed',
        card: {
          kind: 'session',
          prompt: 'calm piano for reading',
          vocal: 'instrumental',
          targetDurationMinutes: 45,
        },
      },
    ]);

    const vibe = openTurn();
    await vibe.call('proposeChangeVibe', { prompt: 'slower' });
    const newMusic = openTurn();
    await newMusic.call('proposeNewMusicOn', { noLimit: true });
    const active = { id: SESSIONS.nightDrive.id, name: 'Night Drive' };
    expect(vibe.reported).toEqual([
      { status: 'proposed', card: { kind: 'changeVibe', session: active, prompt: 'slower' } },
    ]);
    expect(newMusic.reported).toEqual([
      {
        status: 'proposed',
        card: { kind: 'newMusicOn', session: active, targetDurationMinutes: null },
      },
    ]);
  });

  it('hold a turn to the caps of a real one', async () => {
    const { call, reported } = openTurn();

    await call('proposeSession', { prompt: 'calm piano' });
    const second = await call('proposeSession', { prompt: 'loud drums' });

    expect(second).toMatch(/already prepared a card/);
    expect(reported).toHaveLength(1);
  });
});
