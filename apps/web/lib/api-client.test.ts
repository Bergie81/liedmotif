import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  changeVibe,
  dislikeTrack,
  getAllPlaylists,
  getLibrary,
  getTrack,
  listSessions,
  unsaveTrack,
  getSessionQueue,
  updatePlaybackSettings,
} from './api-client';
import { onLibraryWrite } from './offline/library-writes';

// The api-client must validate every response against its merged Zod contract before
// handing it to the UI — the `trackSummary` audioUrl guard only protects the browser
// (provider/stream URLs never reach the client) if a malformed response is
// REJECTED here, not passed through. These tests drive `getSessionQueue` with a
// stubbed `fetch` carrying contract-invalid and contract-valid bodies.

let n = 0;
/** A deterministic, valid v4-shaped UUID for fixtures. */
function uuid(): string {
  n += 1;
  return `0000aaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function stubFetchJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => body })),
  );
}

/** Stub `fetch`, recording the call so a test can assert the path/method/body. */
function captureFetch(body: unknown): { calls: Array<{ path: string; init?: RequestInit }> } {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { json: async () => body };
    }),
  );
  return { calls };
}

function trackFlagsBody() {
  return {
    ok: true,
    data: {
      trackId: uuid(),
      savedAt: '2026-06-28T10:00:00Z',
      favoritedAt: null,
      dislikedAt: null,
      retentionClass: 'durable',
    },
  };
}

function trackSummary(audioUrl: string | null) {
  const id = uuid();
  return {
    id,
    title: 'Track',
    generatedArtistName: null,
    status: 'ready',
    durationSeconds: 10,
    coverImageId: null,
    audioUrl,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
  };
}

function libraryItem(audioUrl: string | null) {
  return {
    ...trackSummary(audioUrl),
    createdAt: '2026-06-28T10:00:00Z',
    hasPlayed: false,
    originSessionId: '223e4567-e89b-12d3-a456-426614174000',
    originSessionTitle: 'Night Shift',
  };
}

function queueBody(
  audioUrl: string | null,
  overrides: { assets?: { final: string | null; stream: string | null } } = {},
) {
  const trackId = uuid();
  return {
    ok: true,
    data: {
      sessionId: uuid(),
      sessionStatus: 'active',
      generationStatus: 'ok',
      generationStatusScope: null,
      statusMessageSafe: null,
      coverImageId: null,
      styleRevision: 1,
      currentTrackId: trackId,
      currentQueueItemId: uuid(),
      earlierTracks: 0,
      items: [
        {
          id: uuid(),
          position: 0,
          state: 'playing',
          vibeSwitchSetAside: false,
          trackId,
          track: {
            id: trackId,
            title: 'Track',
            generatedArtistName: null,
            status: 'ready',
            durationSeconds: 10,
            coverImageId: null,
            audioUrl,
            savedAt: null,
            favoritedAt: null,
            inCuratedPlaylist: false,
            dislikedAt: null,
            genreTags: ['lofi'],
            vocalMode: 'instrumental',
            hasLyrics: false,
            downloadable: true,
          },
          // The blend extension: identity + pinned assets + analysis.
          targetBpm: 124,
          targetKey: 'A minor',
          styleRevision: 1,
          durationSeconds: 10,
          assets: overrides.assets ?? {
            final: `/api/audio/${trackId}?asset=final`,
            stream: null,
          },
          blendAnalysis: {
            version: 1,
            status: 'complete',
            bpm: 123.7,
            bpmSource: 'measured',
            bpmConfidence: 0.9,
            headBeatAnchorSeconds: 0.5,
            headBeatPeriodSeconds: 0.485,
            tailBeatAnchorSeconds: 180,
            tailBeatPeriodSeconds: 0.486,
            integratedLufs: -13.1,
            truePeakDb: -1.5,
          },
        },
      ],
      generatingTracksAhead: 0,
      generatingNewVibeTracksAhead: 0,
      pendingGeneration: null,
      vibe: null,
      switchPending: false,
      tryAgainTracks: null,
    },
  };
}

describe('api-client response validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a response whose track audioUrl is an absolute provider URL', async () => {
    // A leaked provider/stream URL must never reach the caller.
    stubFetchJson(queueBody('https://provider.example/audio/leak.mp3'));
    const res = await getSessionQueue(uuid());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
  });

  it('rejects a protocol-relative audioUrl', async () => {
    stubFetchJson(queueBody('//cdn.provider.example/leak.mp3'));
    const res = await getSessionQueue(uuid());
    expect(res.ok).toBe(false);
  });

  it('accepts a contract-valid response with a same-origin app audioUrl', async () => {
    stubFetchJson(queueBody('/api/audio/abc'));
    const res = await getSessionQueue(uuid());
    expect(res.ok).toBe(true);
    if (res.ok) {
      const item = res.data.items[0]!;
      expect(item.track?.audioUrl).toBe('/api/audio/abc');
      // The blend extension decodes with the same envelope.
      expect(item.targetBpm).toBe(124);
      expect(item.blendAnalysis?.status).toBe('complete');
      expect(item.assets.final).toMatch(/^\/api\/audio\//);
    }
  });

  it('rejects a pinned asset path that is an absolute provider URL', async () => {
    stubFetchJson(
      queueBody('/api/audio/abc', {
        assets: { final: 'https://provider.example/leak.mp3?asset=final', stream: null },
      }),
    );
    const res = await getSessionQueue(uuid());
    expect(res.ok).toBe(false);
  });

  it('passes a well-formed error envelope through unchanged', async () => {
    stubFetchJson({ ok: false, error: { code: 'not_found', message: 'nope', retryable: false } });
    const res = await getSessionQueue(uuid());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });
});

describe('api-client full playlist list', () => {
  afterEach(() => vi.unstubAllGlobals());

  function playlistSummary(id: string) {
    return {
      id,
      name: id,
      kind: 'user',
      listedInPlaylists: true,
      trackCount: 1,
      totalDurationSeconds: 60,
      downloadableTrackCount: 0,
      coverImageId: null,
      mosaicCoverImageIds: [],
      soleMemberTrackCount: 0,
      containsTrack: true,
      sharedAt: null,
      pinnedAt: null,
      createdAt: '2026-07-20T10:00:00.000Z',
      updatedAt: '2026-07-20T10:00:00.000Z',
    };
  }

  it('keeps a Playlist whose activity moved it onto an already-read page mid-load', async () => {
    // The membership picker rewrites the Track's whole set from this list, so a
    // skipped Playlist would lose the Track.
    const [a, b, moved, d] = [uuid(), uuid(), uuid(), uuid()];
    const pages = [
      { playlists: [a, b], nextCursor: 'after-b' },
      // `moved` was played elsewhere between the reads: it left this page for the top.
      { playlists: [d], nextCursor: null },
      { playlists: [moved, a], nextCursor: 'after-a' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const page = pages.shift()!;
        return {
          json: async () => ({
            ok: true,
            data: { playlists: page.playlists.map(playlistSummary), nextCursor: page.nextCursor },
          }),
        };
      }),
    );

    const res = await getAllPlaylists({ containsTrackId: uuid() });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.playlists.map((p) => p.id).sort()).toEqual([a, b, moved, d].sort());
    }
  });
});

describe('api-client Session listing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests a bounded recent page without changing the response contract', async () => {
    const { calls } = captureFetch({
      ok: true,
      data: { items: [], nextCursor: null, activeSession: null, pinned: [] },
    });

    const result = await listSessions({ limit: 2, includeActive: true });

    expect(result.ok).toBe(true);
    expect(calls[0]?.path).toBe('/api/sessions?limit=2&includeActive=true');
  });
});

describe('api-client player Session actions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Change Vibe posts a new intent for the same Session identity', async () => {
    const sessionId = uuid();
    const { calls } = captureFetch({
      ok: true,
      data: {
        session: {
          id: sessionId,
          status: 'active',
          title: 'Turned corner',
          generationStatus: 'ok',
          generationStatusScope: null,
          sessionMode: 'keep_going',
          coverImageId: null,
          statusMessageSafe: null,
          createdAt: '2026-06-28T10:00:00Z',
          updatedAt: '2026-06-28T10:01:00Z',
        },
      },
    });

    const result = await changeVibe(sessionId, {
      mode: 'controls',
      controls: { mood: 'calm', energy: 'low' },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.path).toBe('/api/sessions/change-vibe');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId,
      input: { mode: 'controls', controls: { mood: 'calm', energy: 'low' } },
    });
  });
});

describe('api-client feedback-loop methods', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('unsaveTrack POSTs { trackId, saved: false } to /api/tracks/save and decodes the flags', async () => {
    const { calls } = captureFetch(trackFlagsBody());
    const trackId = uuid();
    const res = await unsaveTrack(trackId);
    expect(calls[0]?.path).toBe('/api/tracks/save');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ trackId, saved: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.retentionClass).toBe('durable');
  });

  it('dislikeTrack POSTs { trackId } to /api/tracks/dislike', async () => {
    const { calls } = captureFetch({
      ok: true,
      data: {
        trackId: uuid(),
        dislikedAt: '2026-06-28T10:00:00Z',
        rerollQueued: true,
        replacementSource: 'sibling',
      },
    });
    const trackId = uuid();
    const res = await dislikeTrack(trackId);
    expect(calls[0]?.path).toBe('/api/tracks/dislike');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ trackId });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.replacementSource).toBe('sibling');
  });

  it('getLibrary REJECTS a library item with a leaked provider audioUrl', async () => {
    stubFetchJson({
      ok: true,
      data: {
        view: 'saved',
        items: [libraryItem('https://provider.example/leak.mp3')],
        nextCursor: null,
      },
    });
    const res = await getLibrary('saved');
    expect(res.ok).toBe(false); // a leaked URL is never handed to the UI
  });

  it('getLibrary accepts a same-origin app audioUrl', async () => {
    stubFetchJson({
      ok: true,
      data: { view: 'saved', items: [libraryItem('/api/audio/abc')], nextCursor: null },
    });
    const res = await getLibrary('saved');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.items[0]?.audioUrl).toBe('/api/audio/abc');
  });

  it('getTrack rejects a leaked audioUrl and accepts an app path', async () => {
    stubFetchJson({ ok: true, data: trackSummary('//cdn.provider.example/leak.mp3') });
    expect((await getTrack(uuid())).ok).toBe(false);

    stubFetchJson({ ok: true, data: trackSummary('/api/audio/xyz') });
    const ok = await getTrack(uuid());
    expect(ok.ok).toBe(true);
  });

  it('announces a successful Track write for the offline sync to follow, never a read or a refusal', async () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', { onLine: true });
    const heard = vi.fn();
    onLibraryWrite(heard);

    captureFetch(trackFlagsBody());
    await unsaveTrack(uuid());
    expect(heard).toHaveBeenCalledTimes(1);

    stubFetchJson({ ok: true, data: trackSummary('/api/audio/xyz') });
    await getTrack(uuid());
    stubFetchJson({
      ok: false,
      error: { code: 'not_found', message: 'Track not found.', retryable: false },
    });
    await unsaveTrack(uuid());
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('api-client playback settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('updatePlaybackSettings POSTs the patch and decodes the effective settings', async () => {
    const { calls } = captureFetch({
      ok: true,
      data: { blendEnabled: false, crossfadeSeconds: 9 },
    });
    const res = await updatePlaybackSettings({ blendEnabled: false, crossfadeSeconds: 9 });
    expect(calls[0]?.path).toBe('/api/settings/playback');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      blendEnabled: false,
      crossfadeSeconds: 9,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.crossfadeSeconds).toBe(9);
  });

  it('a rejected request comes back as the safe typed error, never a throw', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const res = await updatePlaybackSettings({ blendEnabled: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.retryable).toBe(true);
  });

  it('a contract-shaped auth error stays a string-safe message (never an object)', async () => {
    // An expired session answers with the structured error envelope; the form
    // renders `error.message` — it must arrive as a plain string.
    stubFetchJson({
      ok: false,
      error: { code: 'unauthorized', message: 'Sign in required.', retryable: false },
    });
    const res = await updatePlaybackSettings({ crossfadeSeconds: 8 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unauthorized');
      expect(typeof res.error.message).toBe('string');
    }
  });
});
