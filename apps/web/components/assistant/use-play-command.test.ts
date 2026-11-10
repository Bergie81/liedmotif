// @vitest-environment jsdom

// A play command in the browser: which of the app's own play flows it runs
// for a Session, a Playlist and a Track, with the player and the server
// mocked. The flows themselves are the real ones the app's pages use.

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantPlayCommand } from '@liedmotif/shared';
import { usePlayCommand } from './use-play-command';

const FOCUS_ID = '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11';
const MORNING_ID = '3a6d9f10-52c4-4b8e-a7d1-0e9c8b7a6f55';
const RUNNING_ID = '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22';
const TRACK_ID = '5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
const OTHER_TRACK_ID = '9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';

const PLAY_FOCUS: AssistantPlayCommand = {
  name: 'play',
  source: { kind: 'session', id: FOCUS_ID, name: 'Deep Focus' },
};
const PLAY_TRACK: AssistantPlayCommand = {
  ...PLAY_FOCUS,
  track: { id: TRACK_ID, name: 'Night Drive' },
};
const RUNNING_SOURCE = {
  kind: 'playlist',
  id: RUNNING_ID,
  name: 'Running',
  trackCount: 2,
} as const;
const PLAY_RUNNING: AssistantPlayCommand = {
  name: 'play',
  source: { ...RUNNING_SOURCE, foreign: false },
};
const PLAY_SHARED: AssistantPlayCommand = {
  name: 'play',
  source: { ...RUNNING_SOURCE, foreign: true },
};

const player = vi.hoisted(() => ({ context: null as unknown }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => player.context,
  usePlayerActions: () => player.context,
}));
vi.mock('@/components/player/autoplay-arm', () => ({ primePlayerAutoplay: vi.fn() }));
vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));

type Result = { ok: boolean; data?: unknown; error?: { message: string } };
type PageFetcher = (cursor: string | null, limit: number) => Promise<Result>;
const api = vi.hoisted(() => ({
  listSessions: vi.fn<(query: unknown) => Promise<Result>>(),
  resumeSession: vi.fn<(sessionId: string, clientId: string) => Promise<Result>>(),
  playSessionTrack:
    vi.fn<(sessionId: string, trackId: string, clientId: string) => Promise<Result>>(),
  getAllPlaylistMembers: vi.fn<(playlistId: string, fetchPage?: PageFetcher) => Promise<Result>>(),
  getLoungePlaylist:
    vi.fn<(playlistId: string, cursor: string | null, limit: number) => Promise<Result>>(),
  markPlaylistPlayed: vi.fn<(playlistId: string) => Promise<Result>>(),
}));
vi.mock('@/lib/api-client', () => api);

const session = (id: string, status: 'active' | 'stopped' = 'active') => ({ id, status });
const member = (id: string, playable = true) => ({
  id,
  audioUrl: playable ? `/api/audio/${id}` : null,
});
const RUNNING = { id: RUNNING_ID, name: 'Running' };
const NO = { ok: false, error: { message: 'No.' } };

/** The deck of an engaged source: every action a spy. */
function deck(trackId: string | null = null) {
  return {
    status: 'paused',
    currentTrack: trackId ? { trackId } : null,
    queueItems: [],
    playableQueueItemIds: [],
    play: vi.fn(),
    toggle: vi.fn(),
    playQueueItem: vi.fn(),
    refreshQueue: vi.fn(),
  };
}

/** The player with nothing engaged, or with `engaged` on its deck. */
function playerWith(engaged?: {
  session: { id: string; status: string } | null;
  trackId?: string;
}) {
  const controller = engaged ? deck(engaged.trackId) : null;
  const context = {
    playback: engaged ? { session: engaged.session, player: controller } : null,
    engagedSource: engaged?.session ? { kind: 'session', session: engaged.session } : null,
    pending: null,
    engage: vi.fn(),
    engagePlaylist: vi.fn(),
    beginOtherMusic: vi.fn(async () => true),
  };
  player.context = context;
  return { ...context, controller };
}

/** The hook's one function, as the shell holds it. */
const playCommand = () => renderHook(() => usePlayCommand()).result.current;

beforeEach(() => {
  api.listSessions.mockResolvedValue({ ok: true, data: { activeSession: session(MORNING_ID) } });
  api.resumeSession.mockResolvedValue({
    ok: true,
    data: { session: session(FOCUS_ID), supersededSessionId: MORNING_ID },
  });
  api.playSessionTrack.mockResolvedValue({
    ok: true,
    data: { session: session(FOCUS_ID), supersededSessionId: null },
  });
  api.getAllPlaylistMembers.mockImplementation(async (_id, fetchPage) =>
    fetchPage
      ? fetchPage(null, 500)
      : {
          ok: true,
          data: { playlist: RUNNING, items: [member(TRACK_ID), member(OTHER_TRACK_ID)] },
        },
  );
  api.getLoungePlaylist.mockResolvedValue({
    ok: true,
    data: {
      playlist: RUNNING,
      owner: { name: 'Ada' },
      items: [member(TRACK_ID)],
      nextCursor: null,
    },
  });
  api.markPlaylistPlayed.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a play command for a Session', () => {
  it('resumes a stopped Session through the app’s Resume and engages it to play', async () => {
    const { engage } = playerWith();

    expect(await playCommand()(PLAY_FOCUS)).toBe('started');

    expect(api.resumeSession).toHaveBeenCalledExactlyOnceWith(FOCUS_ID, 'client-1');
    expect(engage).toHaveBeenCalledExactlyOnceWith(session(FOCUS_ID), { autoplay: true });
    // Resume is all that reaches the server: nothing sets a mode or a duration.
    for (const call of [api.playSessionTrack, api.getAllPlaylistMembers, api.markPlaylistPlayed]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('engages the active Session a fresh page has not engaged yet, with no Resume', async () => {
    const { engage } = playerWith();
    api.listSessions.mockResolvedValue({ ok: true, data: { activeSession: session(FOCUS_ID) } });

    expect(await playCommand()(PLAY_FOCUS)).toBe('started');

    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(engage).toHaveBeenCalledExactlyOnceWith(session(FOCUS_ID), { autoplay: true });
  });

  it('plays on the Session the player has engaged, and asks the server for nothing', async () => {
    const { controller, engage, beginOtherMusic } = playerWith({ session: session(FOCUS_ID) });

    expect(await playCommand()(PLAY_FOCUS)).toBe('started');

    expect(controller!.play).toHaveBeenCalledOnce();
    expect(engage).not.toHaveBeenCalled();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(beginOtherMusic).not.toHaveBeenCalled();
  });

  it('fails when the Resume is refused, and engages nothing', async () => {
    const { engage } = playerWith();
    api.resumeSession.mockResolvedValue(NO);

    expect(await playCommand()(PLAY_FOCUS)).toBe('failed');
    expect(engage).not.toHaveBeenCalled();
  });
});

describe('a play command for a Playlist', () => {
  it('plays it as its Play button does: the whole membership, from the top, stamped as played', async () => {
    const { engagePlaylist } = playerWith();

    expect(await playCommand()(PLAY_RUNNING)).toBe('started');
    await Promise.resolve();

    expect(api.getAllPlaylistMembers).toHaveBeenCalledExactlyOnceWith(RUNNING_ID, undefined);
    expect(engagePlaylist).toHaveBeenCalledExactlyOnceWith(
      RUNNING,
      [member(TRACK_ID), member(OTHER_TRACK_ID)],
      null,
      { foreign: false },
    );
    expect(api.markPlaylistPlayed).toHaveBeenCalledExactlyOnceWith(RUNNING_ID);
  });

  it('starts at the Track the command names', async () => {
    const { engagePlaylist } = playerWith();

    await playCommand()({ ...PLAY_RUNNING, track: { id: OTHER_TRACK_ID, name: 'Open Road' } });
    await Promise.resolve();

    expect(engagePlaylist.mock.calls[0]?.[2]).toBe(OTHER_TRACK_ID);
  });

  it('plays another user’s Playlist as a Visitor: read from the Lounge, and no play stamp', async () => {
    const { engagePlaylist } = playerWith();

    expect(await playCommand()(PLAY_SHARED)).toBe('started');
    await Promise.resolve();

    expect(api.getLoungePlaylist).toHaveBeenCalledExactlyOnceWith(RUNNING_ID, null, 500);
    expect(engagePlaylist).toHaveBeenCalledExactlyOnceWith(RUNNING, [member(TRACK_ID)], null, {
      foreign: true,
    });
    expect(api.markPlaylistPlayed).not.toHaveBeenCalled();
  });

  it('fails when the Playlist cannot be read, has nothing playable, or lost the Track to start at', async () => {
    const { engagePlaylist } = playerWith();
    const play = playCommand();

    api.getAllPlaylistMembers.mockResolvedValueOnce(NO);
    expect(await play(PLAY_RUNNING)).toBe('failed');

    api.getAllPlaylistMembers.mockResolvedValueOnce({
      ok: true,
      data: { playlist: RUNNING, items: [member(TRACK_ID, false)] },
    });
    expect(await play(PLAY_RUNNING)).toBe('failed');

    api.getAllPlaylistMembers.mockResolvedValueOnce({
      ok: true,
      data: { playlist: RUNNING, items: [member(TRACK_ID), member(OTHER_TRACK_ID, false)] },
    });
    expect(await play({ ...PLAY_RUNNING, track: { id: OTHER_TRACK_ID, name: 'Open Road' } })).toBe(
      'failed',
    );
    await Promise.resolve();

    expect(engagePlaylist).not.toHaveBeenCalled();
  });
});

describe('a play command for one Track', () => {
  it('plays it through its Session, as its row in the Library does', async () => {
    const { engage } = playerWith();

    expect(await playCommand()(PLAY_TRACK)).toBe('started');

    expect(api.playSessionTrack).toHaveBeenCalledExactlyOnceWith(FOCUS_ID, TRACK_ID, 'client-1');
    expect(engage).toHaveBeenCalledExactlyOnceWith(session(FOCUS_ID), { autoplay: true });
    expect(api.resumeSession).not.toHaveBeenCalled();
  });

  it('plays the Track that is already on the deck, and never pauses it', async () => {
    const { controller } = playerWith({ session: session(FOCUS_ID), trackId: TRACK_ID });

    expect(await playCommand()(PLAY_TRACK)).toBe('started');

    expect(controller!.play).toHaveBeenCalledOnce();
    expect(controller!.toggle).not.toHaveBeenCalled();
    expect(api.playSessionTrack).not.toHaveBeenCalled();
  });

  it('fails when the Session no longer has the Track', async () => {
    const { engage } = playerWith();
    api.playSessionTrack.mockResolvedValue(NO);

    expect(await playCommand()(PLAY_TRACK)).toBe('failed');
    expect(engage).not.toHaveBeenCalled();
  });
});

describe('a play command while a new Session is starting', () => {
  it('asks "Play this instead" first, and plays nothing when the user keeps the new Session', async () => {
    const { beginOtherMusic, engage, engagePlaylist } = playerWith({
      session: session(MORNING_ID),
    });
    beginOtherMusic.mockResolvedValue(false);
    const play = playCommand();

    for (const command of [PLAY_FOCUS, PLAY_TRACK, PLAY_RUNNING]) {
      expect(await play(command)).toBe('declined');
    }
    await Promise.resolve();

    expect(beginOtherMusic).toHaveBeenCalledTimes(3);
    expect(engage).not.toHaveBeenCalled();
    expect(engagePlaylist).not.toHaveBeenCalled();
    expect(api.resumeSession).not.toHaveBeenCalled();
    expect(api.playSessionTrack).not.toHaveBeenCalled();
  });

  it('does not ask for a Track of the Session that is engaged, as its row does not', async () => {
    const { beginOtherMusic } = playerWith({ session: session(FOCUS_ID), trackId: OTHER_TRACK_ID });
    beginOtherMusic.mockResolvedValue(false);

    await playCommand()(PLAY_TRACK);

    expect(beginOtherMusic).not.toHaveBeenCalled();
    expect(api.playSessionTrack).toHaveBeenCalledOnce();
  });
});

describe('two play commands of one message', () => {
  it('run one after the other, so each learns what came of its own flow', async () => {
    playerWith();
    let answerFirst: (result: Result) => void = () => undefined;
    api.resumeSession.mockReturnValueOnce(
      new Promise<Result>((resolve) => {
        answerFirst = resolve;
      }),
    );
    const play = playCommand();

    const first = play(PLAY_FOCUS);
    const second = play(PLAY_TRACK);
    await vi.waitFor(() => expect(api.resumeSession).toHaveBeenCalledOnce());
    expect(api.playSessionTrack).not.toHaveBeenCalled();

    answerFirst(NO);
    expect(await first).toBe('failed');
    expect(await second).toBe('started');
  });
});
