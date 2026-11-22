// The eval's stand-in for the asking user's music. It has to offer the model
// exactly what a real turn offers, answer every call without a database, and
// leave nothing changed: what a tool did is only ever reported.

import { describe, expect, it } from 'vitest';
import type { AssistantAction } from '@liedmotif/shared';
import { createAssistantTools } from '../tools';
import { createTurnActions } from '../turn-actions';
import { fixtureTools, PLAYLISTS, SESSIONS, TRACKS } from './fixture';

/** One fixture turn: its tools by name, and the actions it reported. */
function openTurn(role: 'admin' | 'member' = 'member', options?: { nothingPlaying?: boolean }) {
  const reported: AssistantAction[] = [];
  const tools = fixtureTools(
    role,
    createTurnActions((action) => reported.push(action)),
    options,
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
  readTrack: {},
  favoriteTrack: {},
  addToPlaylist: { playlistId: PLAYLISTS.running.id },
  createPlaylist: { name: 'Gym' },
  renamePlaylist: { playlistId: PLAYLISTS.running.id, name: 'Tempo' },
  pinPlaylist: { playlistId: PLAYLISTS.running.id },
  renameSession: { name: 'Sunday Coffee' },
  pinSession: {},
  renameTrack: { name: 'Harbor Lights' },
  newMusicOff: {},
  changeSetting: { setting: 'blend', value: 'off' },
  play: { kind: 'playlist', id: PLAYLISTS.running.id },
  playerControl: { command: 'next' },
  sleepTimer: { minutes: 30 },
  proposeSession: { prompt: 'calm piano for reading', targetDurationMinutes: 45 },
  proposeChangeVibe: { prompt: 'slower' },
  proposeMoreLikeThis: { targetDurationMinutes: 60 },
  proposeNewMusicOn: { noLimit: true },
  proposeSurprise: { adventurous: true, theme: 'morning' },
  proposeCover: { in: 'session', guidance: 'darker' },
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

  it('tell the budget in covers too, as the real tool does', async () => {
    expect(await openTurn('member').call('budget')).toMatch(
      /^Your budget: .* \d+ of \d+ covers left today/,
    );
    expect(await openTurn('admin').call('budget')).toMatch(/\d+ of \d+ covers left today/);
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

describe('the Track tool of a fixture turn', () => {
  it('reads the Track Data and lyrics of the Track that is playing', async () => {
    const read = await openTurn().call('readTrack');

    expect(read).toContain(`Track "Neon Rain" (id ${TRACKS.neonRain.id})`);
    expect(read).toContain('Session: Night Drive');
    expect(read).toMatch(/^Style prompt: .*synthwave/m);
    expect(read).toContain(`Lyrics:\n${TRACKS.neonRain.lyrics}`);
  });

  it('says an instrumental has no lyrics, and knows no other id', async () => {
    const { call } = openTurn();

    expect(await call('readTrack', { trackId: TRACKS.firstLight.id })).toContain(
      'Lyrics: none, it is instrumental.',
    );
    expect(await call('readTrack', { trackId: PLAYLISTS.running.id })).toBe(
      'No Track with that id.',
    );
    expect(await openTurn('member', { nothingPlaying: true }).call('readTrack')).toMatch(
      /^No Track is playing/,
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
    await call('proposeMoreLikeThis', { targetDurationMinutes: 60 });

    expect(reported).toMatchObject([
      { receipt: { action: 'addToPlaylist', tracks: [{ id: TRACKS.neonRain.id }] } },
      {
        card: {
          kind: 'moreLikeThis',
          tracks: [{ id: TRACKS.neonRain.id, name: 'Neon Rain' }],
          targetDurationMinutes: 60,
        },
      },
    ]);
  });

  it('carry a More Like This context onto the card, as the real tool does', async () => {
    // One card per turn, so each call gets a turn of its own.
    const withContext = openTurn();
    const blank = openTurn();

    await withContext.call('proposeMoreLikeThis', {
      targetDurationMinutes: 60,
      context: ' for cooking ',
    });
    await blank.call('proposeMoreLikeThis', { targetDurationMinutes: 60, context: '' });

    expect(withContext.reported).toMatchObject([
      { card: { kind: 'moreLikeThis', context: 'for cooking' } },
    ]);
    expect(blank.reported).toMatchObject([{ card: { kind: 'moreLikeThis' } }]);
    expect(blank.reported[0]).not.toHaveProperty('card.context');
  });

  it('ask how long before More Like This, as before a new Session, when no length is given', async () => {
    const { call, reported } = openTurn();

    expect(await call('proposeMoreLikeThis')).toMatch(/ask the user how long/i);
    expect(await call('proposeSession', { prompt: 'calm piano' })).toMatch(
      /ask the user how long/i,
    );
    expect(await call('proposeMoreLikeThis', { noLimit: true })).toMatch(
      /^Prepared: .*with no limit/,
    );
    expect(reported).toMatchObject([
      { card: { kind: 'moreLikeThis', targetDurationMinutes: null } },
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
    // The seed check comes before the length question, as in the real tool.
    expect(await call('proposeMoreLikeThis', { trackIds: [unknown] })).toMatch(
      /^No Track with that id\./,
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

  it('rename and pin the Session that is on for "this", and rename the Track on the deck', async () => {
    const { call, reported } = openTurn();

    expect(await call('renameSession', { name: ' Sunday Coffee ' })).toMatch(/^Done: /);
    await call('pinSession', {});
    await call('renameTrack', { name: 'Harbor Lights' });

    expect(reported).toEqual([
      {
        status: 'done',
        receipt: {
          action: 'renameSession',
          session: { id: SESSIONS.nightDrive.id, name: 'Sunday Coffee' },
          previousName: 'Night Drive',
        },
      },
      {
        status: 'done',
        receipt: {
          action: 'pinSession',
          session: { id: SESSIONS.nightDrive.id, name: 'Night Drive' },
        },
      },
      {
        status: 'done',
        receipt: {
          action: 'renameTrack',
          track: { id: TRACKS.neonRain.id, name: 'Harbor Lights' },
          previousName: 'Neon Rain',
        },
      },
    ]);
  });

  it('prepare a card for a new cover and for a Surprise Me suggestion, and generate nothing', async () => {
    const cover = openTurn();
    const told = await cover.call('proposeCover', { in: 'session', guidance: ' darker ' });
    const playlistCover = openTurn();
    await playlistCover.call('proposeCover', { in: 'playlist', id: PLAYLISTS.running.id });

    expect(told).toMatch(
      /^Prepared: a card to generate one new cover for the Session "Night Drive"/,
    );
    expect(cover.reported).toEqual([
      {
        status: 'proposed',
        card: {
          kind: 'cover',
          subject: { kind: 'session', id: SESSIONS.nightDrive.id, name: 'Night Drive' },
          guidance: 'darker',
        },
      },
    ]);
    expect(playlistCover.reported).toEqual([
      {
        status: 'proposed',
        card: {
          kind: 'cover',
          subject: { kind: 'playlist', id: PLAYLISTS.running.id, name: 'Running' },
        },
      },
    ]);

    const surprise = openTurn();
    expect(
      await surprise.call('proposeSurprise', { adventurous: true, targetDurationMinutes: 30 }),
    ).toMatch(/^Prepared: a card to start the Surprise Me suggestion "/);
    expect(surprise.reported).toMatchObject([
      {
        status: 'proposed',
        card: {
          kind: 'surprise',
          suggestion: { adventurous: true, vocalMode: 'instrumental' },
          targetDurationMinutes: 30,
        },
      },
    ]);
  });

  it('turn down a cover for a Playlist that is not playing when the call names none', async () => {
    const { call, reported } = openTurn();

    expect(await call('proposeCover', { in: 'playlist' })).toMatch(/No Playlist is playing/);
    expect(reported).toEqual([]);
  });

  it('refuse "this" when nothing is playing, and say so when asked what is', async () => {
    const { call, reported } = openTurn('member', { nothingPlaying: true });

    expect(await call('nowPlaying')).toMatch(/^Nothing is playing in this browser\./);
    expect(await call('renameTrack', { name: 'Harbor Lights' })).toMatch(/No Track is playing/);
    expect(await call('renameSession', { name: 'Sunday Coffee' })).toMatch(/No Session is playing/);
    expect(await call('proposeCover', { in: 'session' })).toMatch(/No Session is playing/);
    expect(await call('favoriteTrack')).toMatch(/No Track is playing/);
    expect(await call('playerControl', { command: 'pause' })).not.toMatch(/^Done/);
    expect(reported).toEqual([]);
  });

  it('hold a turn to the caps of a real one', async () => {
    const { call, reported } = openTurn();

    await call('proposeSession', { prompt: 'calm piano', targetDurationMinutes: 45 });
    const second = await call('proposeSession', { prompt: 'loud drums', noLimit: true });

    expect(second).toMatch(/No second card was shown/);
    expect(reported).toHaveLength(1);
  });
});
