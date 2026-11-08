import { describe, expect, it } from 'vitest';
import type { PlaylistSummaryItem, SessionSummary } from '@liedmotif/shared';
import {
  abandonPendingPlayback,
  beginHandoffDrain,
  endHandoffDrain,
  engagePlayback,
  HANDOFF_FADE_MS,
  handoffFadeDurationMs,
  handoffFadeGains,
  idlePlaybackState,
  pairLivePlayback,
  pendingHandoffAction,
  promotePendingPlayback,
  releasePlayback,
  sleepTimerTargets,
  type EngagedSource,
  type ProviderPlaybackState,
} from './player-provider-model';
import type { PlaybackControllerApi } from './playback-controller-api';

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: SESSION_A,
    status: 'active',
    title: 'Focus Flow',
    generationStatus: 'ok',
    generationStatusScope: null,
    sessionMode: 'keep_going',
    coverImageId: null,
    statusMessageSafe: null,
    createdAt: '2026-07-18T09:00:00.000Z',
    updatedAt: '2026-07-18T09:00:00.000Z',
    ...overrides,
  };
}

function sessionSource(overrides: Partial<SessionSummary> = {}): EngagedSource {
  return { kind: 'session', session: summary(overrides) };
}

const PLAYLIST_ID = '00000000-0000-4000-8000-0000000000aa';

function playlistSource(): EngagedSource {
  const playlist: PlaylistSummaryItem = {
    id: PLAYLIST_ID,
    name: 'Deep Work Winners',
    kind: 'user',
    listedInPlaylists: true,
    trackCount: 2,
    totalDurationSeconds: 360,
    downloadableTrackCount: 0,
    coverImageId: null,
    mosaicCoverImageIds: [],
    soleMemberTrackCount: 0,
    containsTrack: null,
    sharedAt: null,
    pinnedAt: null,
    createdAt: '2026-07-23T09:00:00.000Z',
    updatedAt: '2026-07-23T09:00:00.000Z',
  };
  return { kind: 'playlist', playlist, items: [], startTrackId: null, foreign: false };
}

describe('pairLivePlayback', () => {
  const player = {} as PlaybackControllerApi;
  const hosted = { sourceId: SESSION_A, player, coldStartBeganAt: '2026-07-18T09:00:00.000Z' };

  it('pairs the engaged summary with its own hosted controller', () => {
    const entry = { source: sessionSource(), autoplay: false };
    expect(pairLivePlayback(entry, hosted)).toEqual({
      source: entry.source,
      session: entry.source.kind === 'session' ? entry.source.session : null,
      player,
      coldStartBeganAt: hosted.coldStartBeganAt,
    });
  });

  it('pairs a playlist source with a null session (no Session shell)', () => {
    const entry = { source: playlistSource(), autoplay: true };
    const playlistHosted = { ...hosted, sourceId: PLAYLIST_ID };
    const paired = pairLivePlayback(entry, playlistHosted);
    expect(paired?.session).toBeNull();
    expect(paired?.source.kind).toBe('playlist');
  });

  it('exposes no live playback mid-switch or while nothing is engaged', () => {
    // A hosted publication for a source that is no longer engaged must never
    // pair — the keyed controller swap passes through exactly this state.
    expect(
      pairLivePlayback({ source: sessionSource({ id: SESSION_B }), autoplay: false }, hosted),
    ).toBe(null);
    expect(pairLivePlayback(null, hosted)).toBe(null);
    expect(pairLivePlayback({ source: sessionSource(), autoplay: false }, null)).toBe(null);
  });
});

const SESSION_C = '00000000-0000-4000-8000-00000000000c';

function playingState(): ProviderPlaybackState {
  return {
    entry: { source: sessionSource(), autoplay: true },
    pending: null,
    draining: null,
  };
}

function entrySessionId(entry: { source: EngagedSource } | null): string | null {
  return entry && entry.source.kind === 'session' ? entry.source.session.id : null;
}

function entrySessionTitle(entry: { source: EngagedSource } | null): string | null {
  return entry && entry.source.kind === 'session' ? entry.source.session.title : null;
}

describe('engagePlayback (source handoff)', () => {
  it('engages from idle directly', () => {
    const state = engagePlayback(idlePlaybackState, sessionSource(), true, false);
    expect(entrySessionId(state.entry)).toBe(SESSION_A);
    expect(state.pending).toBeNull();
  });

  it('refreshes the entry summary in place for the same id, keeping the autoplay arm', () => {
    const state = engagePlayback(playingState(), sessionSource({ title: 'Renamed' }), false, true);
    expect(entrySessionTitle(state.entry)).toBe('Renamed');
    expect(state.entry?.autoplay).toBe(true);
    expect(state.pending).toBeNull();
  });

  it('arms a muted pending handoff when another session is audible', () => {
    const state = engagePlayback(playingState(), sessionSource({ id: SESSION_B }), false, true);
    expect(entrySessionId(state.entry)).toBe(SESSION_A);
    expect(entrySessionId(state.pending)).toBe(SESSION_B);
    // Continuity: a source engaged over audible playback ALWAYS auto-starts —
    // the crossfade needs it audible, whatever the caller requested.
    expect(state.pending?.autoplay).toBe(true);
  });

  it('arms a playlist over an audible session the same way (one transport)', () => {
    const state = engagePlayback(playingState(), playlistSource(), true, true);
    expect(entrySessionId(state.entry)).toBe(SESSION_A);
    expect(state.pending?.source.kind).toBe('playlist');
    expect(state.pending?.autoplay).toBe(true);
  });

  it('arms the active Session over an audible Playlist for the return handoff', () => {
    const playlistPlaying: ProviderPlaybackState = {
      entry: { source: playlistSource(), autoplay: true },
      pending: null,
      draining: null,
    };

    const state = engagePlayback(playlistPlaying, sessionSource(), false, true);

    expect(state.entry?.source.kind).toBe('playlist');
    expect(entrySessionId(state.pending)).toBe(SESSION_A);
    expect(state.pending?.autoplay).toBe(true);
  });

  it('swaps directly when nothing is audible', () => {
    const state = engagePlayback(playingState(), sessionSource({ id: SESSION_B }), false, false);
    expect(entrySessionId(state.entry)).toBe(SESSION_B);
    expect(state.pending).toBeNull();
  });

  it('refreshes a pending summary in place and supersedes it with a third session', () => {
    const armed = engagePlayback(playingState(), sessionSource({ id: SESSION_B }), false, true);
    const refreshed = engagePlayback(
      armed,
      sessionSource({ id: SESSION_B, title: 'Fresh' }),
      false,
      true,
    );
    expect(entrySessionTitle(refreshed.pending)).toBe('Fresh');
    const superseded = engagePlayback(refreshed, sessionSource({ id: SESSION_C }), true, true);
    expect(entrySessionId(superseded.pending)).toBe(SESSION_C);
    expect(entrySessionId(superseded.entry)).toBe(SESSION_A);
  });
});

describe('handoff lifecycle transitions', () => {
  const armed: ProviderPlaybackState = {
    entry: { source: sessionSource(), autoplay: true },
    pending: { source: sessionSource({ id: SESSION_B }), autoplay: true },
    draining: null,
  };

  it('beginHandoffDrain promotes the pending session and drains the old one', () => {
    expect(beginHandoffDrain(armed)).toEqual({
      entry: armed.pending,
      pending: null,
      draining: armed.entry,
    });
  });

  it('promotePendingPlayback swaps without a drain (old side is not audible)', () => {
    expect(promotePendingPlayback(armed)).toEqual({
      entry: armed.pending,
      pending: null,
      draining: null,
    });
  });

  it('endHandoffDrain releases the drained host; abandonPendingPlayback keeps the entry', () => {
    expect(endHandoffDrain(beginHandoffDrain(armed)).draining).toBeNull();
    expect(abandonPendingPlayback(armed)).toEqual({ ...armed, pending: null });
  });

  it('releasePlayback stops the visible session but keeps an arming handoff alive', () => {
    expect(releasePlayback(armed)).toEqual({
      entry: armed.pending,
      pending: null,
      draining: null,
    });
    expect(releasePlayback(playingState())).toEqual(idlePlaybackState);
  });
});

describe('pendingHandoffAction', () => {
  it('begins the drain fade when both sides are audible', () => {
    expect(
      pendingHandoffAction({
        pendingStatus: 'playing',
        pendingSessionStatus: 'active',
        entryStatus: 'playing',
      }),
    ).toBe('begin-drain');
  });

  it('promotes silently when the old side went quiet on its own', () => {
    for (const entryStatus of ['ended', 'waiting', null] as const) {
      expect(
        pendingHandoffAction({
          pendingStatus: 'playing',
          pendingSessionStatus: 'active',
          entryStatus,
        }),
      ).toBe('promote');
    }
  });

  it('promotes PAUSED when the user explicitly paused during the handoff', () => {
    // A pause is a "not now" for all music — the new session must not blare
    // in on its own once it becomes ready.
    expect(
      pendingHandoffAction({
        pendingStatus: 'playing',
        pendingSessionStatus: 'active',
        entryStatus: 'paused',
      }),
    ).toBe('promote-paused');
  });

  it('abandons a pending session that stopped before ever playing', () => {
    expect(
      pendingHandoffAction({
        pendingStatus: 'waiting',
        pendingSessionStatus: 'stopped',
        entryStatus: 'playing',
      }),
    ).toBe('abandon');
  });

  it('keeps waiting while the pending session is still arming', () => {
    expect(
      pendingHandoffAction({
        pendingStatus: 'loading',
        pendingSessionStatus: 'active',
        entryStatus: 'playing',
      }),
    ).toBeNull();
    expect(
      pendingHandoffAction({
        pendingStatus: null,
        pendingSessionStatus: 'active',
        entryStatus: 'playing',
      }),
    ).toBeNull();
  });
});

describe('handoffFadeGains', () => {
  it('runs an equal-power curve from the outgoing to the incoming session', () => {
    expect(handoffFadeGains(0, HANDOFF_FADE_MS)).toEqual({
      incoming: 0,
      outgoing: 1,
      done: false,
    });
    const half = handoffFadeGains(HANDOFF_FADE_MS / 2, HANDOFF_FADE_MS);
    expect(half.incoming).toBeCloseTo(Math.SQRT1_2, 5);
    expect(half.outgoing).toBeCloseTo(Math.SQRT1_2, 5);
    expect(half.done).toBe(false);
  });

  it('clamps past the end and reports done', () => {
    expect(handoffFadeGains(HANDOFF_FADE_MS + 1000, HANDOFF_FADE_MS)).toEqual({
      incoming: 1,
      outgoing: 0,
      done: true,
    });
  });
});

describe('handoffFadeDurationMs', () => {
  it('crossfades with blending on and hard-cuts with blending off', () => {
    expect(handoffFadeDurationMs(true)).toBe(HANDOFF_FADE_MS);
    expect(handoffFadeGains(0, handoffFadeDurationMs(false))).toEqual({
      incoming: 1,
      outgoing: 0,
      done: true,
    });
  });
});

describe('sleepTimerTargets', () => {
  it('silences the audible sides of a handoff, never a pending Start still arming', () => {
    const state: ProviderPlaybackState = {
      entry: { source: sessionSource(), autoplay: false },
      pending: { source: playlistSource(), autoplay: true },
      draining: { source: sessionSource({ id: SESSION_B }), autoplay: false },
    };
    expect(sleepTimerTargets(state)).toEqual([SESSION_A, SESSION_B]);
  });

  it('has nothing to silence while nothing is engaged', () => {
    expect(sleepTimerTargets(idlePlaybackState)).toEqual([]);
  });
});
