import { describe, expect, it } from 'vitest';
import {
  PLAYLIST_OPTIONS_SCOPES,
  SESSION_OPTIONS_SCOPES,
  offlineOptionsScopes,
  playlistOptionsScopes,
  visitorPlaylistOptionsScopes,
  type OptionsScopeSpec,
} from './player-options-model';

function rowIds(scopes: readonly { rows: readonly { id: string }[] }[]): string[][] {
  return scopes.map((scope) => scope.rows.map((row) => row.id));
}

describe('player options menu', () => {
  it('reads the Track first, then the Playback source it plays inside', () => {
    expect(SESSION_OPTIONS_SCOPES.map((scope) => scope.label)).toEqual([
      'This Track',
      'This Session',
    ]);
    expect(PLAYLIST_OPTIONS_SCOPES.map((scope) => scope.label)).toEqual([
      'This Track',
      'This Playlist',
    ]);
  });

  it('gives both sources the shared Track rows, plus what only that source can do', () => {
    expect(SESSION_OPTIONS_SCOPES[0].rows.map((row) => row.id)).toEqual([
      'rename-track',
      'track-data',
      'section-loop',
      'reroll-track',
      'more-like-this-track',
      'download-track',
      'delete-track',
    ]);
    expect(PLAYLIST_OPTIONS_SCOPES[0].rows.map((row) => row.id)).toEqual([
      'lyrics',
      'rename-track',
      'track-data',
      'section-loop',
      'download-track',
      'remove-from-playlist',
      'delete-track',
    ]);
  });

  it('carries the direction actions in both scopes, after the rows that read', () => {
    expect(SESSION_OPTIONS_SCOPES[1].rows.map((row) => row.id)).toEqual([
      'change-vibe',
      'sleep-timer',
      'rename-session',
      'convert-session-to-playlist',
      'download-session',
      'delete-session',
    ]);
    const reroll = SESSION_OPTIONS_SCOPES[0].rows.find((row) => row.id === 'reroll-track');
    expect(reroll).toMatchObject({ availability: 'available', tone: 'neutral' });
    const seed = SESSION_OPTIONS_SCOPES[0].rows.find((row) => row.id === 'more-like-this-track');
    expect(seed).toMatchObject({
      availability: 'available',
      description: expect.stringContaining('new session'),
    });
    const vibe = SESSION_OPTIONS_SCOPES[1].rows.find((row) => row.id === 'change-vibe');
    expect(vibe).toMatchObject({ availability: 'available', tone: 'neutral' });
  });

  it('keeps removing a Track from a Playlist curation rather than destruction', () => {
    const row = PLAYLIST_OPTIONS_SCOPES[0].rows.find((item) => item.id === 'remove-from-playlist');
    expect(row).toMatchObject({ availability: 'available', tone: 'neutral' });
  });

  it('ships every row — no roadmap placeholders remain', () => {
    const scopes: readonly OptionsScopeSpec[] = [
      ...SESSION_OPTIONS_SCOPES,
      ...PLAYLIST_OPTIONS_SCOPES,
    ];
    const comingLater = scopes.flatMap((scope) =>
      scope.rows.filter((row) => row.availability === 'coming-later').map((row) => row.id),
    );
    expect(comingLater).toEqual([]);
  });

  it('ships Delete Track and Delete Session under a Session, both marked permanent', () => {
    const track = SESSION_OPTIONS_SCOPES[0].rows.find((item) => item.id === 'delete-track');
    expect(track).toMatchObject({
      availability: 'available',
      tone: 'danger',
      description: expect.stringContaining('for good'),
    });
    const session = SESSION_OPTIONS_SCOPES[1].rows.find((item) => item.id === 'delete-session');
    expect(session).toMatchObject({
      availability: 'available',
      tone: 'danger',
      description: expect.stringMatching(/for good.*saved tracks stay/),
    });
  });

  it('ships Delete Track on a Playlist, where it destroys audio rather than a membership', () => {
    const row = PLAYLIST_OPTIONS_SCOPES[0].rows.find((item) => item.id === 'delete-track');
    expect(row).toMatchObject({
      availability: 'available',
      tone: 'danger',
      description: expect.stringContaining('for good'),
    });
  });

  it('says More Like This lands somewhere else — a Playlist absorbs no generated Tracks', () => {
    const row = PLAYLIST_OPTIONS_SCOPES[1].rows.find((item) => item.id === 'more-like-this');
    expect(row).toMatchObject({
      availability: 'available',
      description: expect.stringContaining('new session'),
    });
  });

  it('paints exactly the Deletes in warn red', () => {
    const danger = [...SESSION_OPTIONS_SCOPES, ...PLAYLIST_OPTIONS_SCOPES].flatMap((scope) =>
      scope.rows.filter((row) => row.tone === 'danger').map((row) => row.id),
    );
    expect(new Set(danger)).toEqual(new Set(['delete-track', 'delete-session', 'delete-playlist']));
  });

  it('offers a hand-made Playlist its own name and end', () => {
    expect(rowIds(playlistOptionsScopes('user'))).toEqual(rowIds(PLAYLIST_OPTIONS_SCOPES));
  });

  it('withholds Rename and Delete from Favorites, which the app makes and names', () => {
    expect(rowIds(playlistOptionsScopes('favorites'))[1]).toEqual([
      'go-to-playlist',
      'sleep-timer',
      'download-playlist',
      'more-like-this',
    ]);
  });

  it('still lets a Track leave Favorites — only naming and ending it are the app’s', () => {
    expect(rowIds(playlistOptionsScopes('favorites'))[0]).toContain('remove-from-playlist');
  });

  // The visitor scope: a leaked owner row here is a curation
  // affordance on somebody else's playlist — the member-invisible rule says
  // absent, never disabled.
  it('gives a visitor only what reads or plays: Track Data, the way to the playlist, the Sleep Timer', () => {
    const scopes = visitorPlaylistOptionsScopes();
    expect(scopes.map((scope) => scope.label)).toEqual(['This Track', 'This Playlist']);
    expect(rowIds(scopes)).toEqual([
      ['lyrics', 'track-data', 'section-loop'],
      ['go-to-playlist', 'sleep-timer', 'more-like-this'],
    ]);
  });

  // Foreign seeding: the visitor's More Like This is a
  // live row that names WHOSE money it spends — the owner-scope description
  // would read as spending the sharer's budget.
  it('offers a visitor a live More Like This labeled as spending THEIR budget', () => {
    const scopes = visitorPlaylistOptionsScopes();
    const seed = scopes[1]!.rows.find((row) => row.id === 'more-like-this');
    expect(seed).toMatchObject({
      availability: 'available',
      description: expect.stringContaining('your own budget'),
    });
  });

  it('never promises a visitor the curation only the owner has', () => {
    const scopes = visitorPlaylistOptionsScopes();
    const goTo = scopes[1]!.rows.find((row) => row.id === 'go-to-playlist');
    expect(goTo?.description).not.toMatch(/reorder|add|remove/i);
  });

  // The Offline Library is listen-only: a row that needs the server has no
  // place there, not even disabled.
  it('gives the Offline Library only what plays from the device: Lyrics, Track Data, the Sleep Timer', () => {
    const scopes = offlineOptionsScopes('Session');
    expect(scopes.map((scope) => scope.label)).toEqual(['This Track', 'This Session']);
    expect(rowIds(scopes)).toEqual([['lyrics', 'track-data'], ['sleep-timer']]);
  });
});
