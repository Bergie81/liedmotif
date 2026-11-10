import { describe, expect, it } from 'vitest';
import type { EngagedSource } from '@/components/player/player-provider-model';
import { assistantPlayerState } from './player-state';

const SESSION_ID = '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11';
const PLAYLIST_ID = '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22';
const TRACK_ID = '5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';

const session = { kind: 'session', session: { id: SESSION_ID } } as EngagedSource;
const playlist = { kind: 'playlist', playlist: { id: PLAYLIST_ID } } as EngagedSource;
const onDeck = { trackId: TRACK_ID };

describe('what the panel tells the Assistant about the player', () => {
  it('is nothing while the player has nothing engaged', () => {
    expect(assistantPlayerState(null)).toBeUndefined();
  });

  it('names a playing Session and the Track on its deck', () => {
    expect(
      assistantPlayerState({
        source: session,
        player: { status: 'playing', currentTrack: onDeck },
      }),
    ).toEqual({ source: { kind: 'session', id: SESSION_ID }, trackId: TRACK_ID, playing: true });
  });

  it('names a paused Playlist', () => {
    expect(
      assistantPlayerState({
        source: playlist,
        player: { status: 'paused', currentTrack: onDeck },
      }),
    ).toEqual({ source: { kind: 'playlist', id: PLAYLIST_ID }, trackId: TRACK_ID, playing: false });
  });

  it('counts only audible playback as playing, and has no Track before one is ready', () => {
    for (const status of ['loading', 'ready', 'waiting', 'ended'] as const) {
      expect(
        assistantPlayerState({ source: session, player: { status, currentTrack: null } }),
      ).toEqual({ source: { kind: 'session', id: SESSION_ID }, trackId: null, playing: false });
    }
  });

  it('says when a running Sleep Timer ends, and leaves it out while none runs', () => {
    const playing = {
      source: session,
      player: { status: 'playing', currentTrack: onDeck },
    } as const;
    const endsAt = Date.parse('2026-11-10T22:30:00.000Z');

    expect(assistantPlayerState(playing, endsAt)).toEqual({
      source: { kind: 'session', id: SESSION_ID },
      trackId: TRACK_ID,
      playing: true,
      sleepTimerEndsAt: endsAt,
    });
    expect(assistantPlayerState(playing, null)).not.toHaveProperty('sleepTimerEndsAt');
    expect(assistantPlayerState(null, endsAt)).toBeUndefined();
  });

  it('is nothing for an offline collection, which plays where no server can be asked', () => {
    const offline = { kind: 'offline', key: `playlist:${PLAYLIST_ID}` } as EngagedSource;

    expect(
      assistantPlayerState({
        source: offline,
        player: { status: 'playing', currentTrack: onDeck },
      }),
    ).toBeUndefined();
  });
});
