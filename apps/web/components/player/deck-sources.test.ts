import { resolveObjectURL } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { DeckSources } from './deck-sources';
import type { PlayableTrack } from './playable-track';

// The per-deck pinned source ladder: try the pinned final, step
// down to the pinned stream on error, commit the kind of whichever URL reached
// readiness — and reset the playback rate on EVERY load so a rate nudge left by
// an earlier aligned edge cannot leak into the next track.

interface FakeElement {
  src: string;
  playbackRate: number;
  loads: number;
  paused: boolean;
  readyState: number;
  error: MediaError | null;
}

function fakeEl(): FakeElement & HTMLAudioElement {
  const el = {
    src: '',
    playbackRate: 1,
    loads: 0,
    paused: false,
    // Ready + errored by default: most tests drive the happy/ladder paths.
    readyState: 4,
    error: { code: 4 } as MediaError,
    load() {
      el.loads += 1;
    },
    pause() {
      el.paused = true;
    },
    removeAttribute(name: string) {
      if (name === 'src') el.src = '';
    },
  };
  return el as unknown as FakeElement & HTMLAudioElement;
}

function track(assets: PlayableTrack['assets']): PlayableTrack {
  return {
    queueState: 'queued',
    vibeSwitchSetAside: false,
    queueItemId: 'qi',
    trackId: 'tr',
    title: null,
    artist: null,
    originSessionTitle: null,
    durationSeconds: 120,
    coverImageId: null,
    genreTags: [],
    vocalMode: 'instrumental' as const,
    hasLyrics: false,
    downloadable: true,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    assets,
    styleRevision: 1,
    targetBpm: 120,
    targetKey: null,
    blendAnalysis: null,
  };
}

function setup(stored: Record<string, Blob> = {}) {
  const els = { a: fakeEl(), b: fakeEl() };
  const sources = new DeckSources(
    (deck) => els[deck],
    (trackId) => stored[trackId] ?? null,
  );
  return { els, sources };
}

/** What an object URL still serves; null once it was revoked. */
async function served(url: string): Promise<string | null> {
  return (await resolveObjectURL(url)?.text()) ?? null;
}

describe('DeckSources', () => {
  it('loads the pinned final first and resets a leaked rate nudge', () => {
    const { els, sources } = setup();
    els.a.playbackRate = 1.06; // left behind by an earlier aligned edge
    expect(sources.begin('a', track({ final: '/api/audio/t?asset=final', stream: null }))).toBe(
      true,
    );
    expect(els.a.src).toBe('/api/audio/t?asset=final');
    expect(els.a.playbackRate).toBe(1);
    expect(els.a.loads).toBe(1);
  });

  it('refuses a track with no pinned assets', () => {
    const { sources } = setup();
    expect(sources.begin('a', track({ final: null, stream: null }))).toBe(false);
  });

  it('steps down the ladder on error and commits the kind that got ready', () => {
    const { els, sources } = setup();
    sources.begin('a', track({ final: '/f?asset=final', stream: '/f?asset=stream' }));
    expect(sources.committedKind('a')).toBeNull();
    // The pinned final 404s → the stream is the next rung.
    expect(sources.stepDown('a')).toBe(true);
    expect(els.a.src).toBe('/f?asset=stream');
    // Readiness commits the kind of the CURRENT rung.
    expect(sources.commitOnReady('a')).toBe(true);
    expect(sources.committedKind('a')).toBe('stream');
    // Committed decks do not step down (a later mid-play error is not a rung).
    expect(sources.stepDown('a')).toBe(false);
    // A second canplay (seek/loop) does not re-commit.
    expect(sources.commitOnReady('a')).toBe(false);
  });

  it('ignores a STALE canplay from a superseded load attempt (element not ready)', () => {
    const { els, sources } = setup();
    sources.begin('a', track({ final: '/c?asset=final', stream: null }));
    // A queued readiness task from the aborted previous resource: the element
    // itself is NOT ready for the new source yet.
    els.a.readyState = 0;
    expect(sources.commitOnReady('a')).toBe(false);
    expect(sources.committedKind('a')).toBeNull();
    // The real readiness commits.
    els.a.readyState = 4;
    expect(sources.commitOnReady('a')).toBe(true);
  });

  it('ignores a STALE error from a superseded load attempt (no live element error)', () => {
    const { els, sources } = setup();
    sources.begin('a', track({ final: '/c?asset=final', stream: '/c?asset=stream' }));
    els.a.error = null; // the load algorithm nulled the previous error
    expect(sources.stepDown('a')).toBe(false);
    expect(els.a.src).toBe('/c?asset=final'); // ladder unmoved
  });

  it('exhausts the ladder when no rung is left', () => {
    const { sources } = setup();
    sources.begin('a', track({ final: '/f?asset=final', stream: null }));
    expect(sources.stepDown('a')).toBe(false);
  });

  it('unload stops and clears the element; clear only forgets the ladder', () => {
    const { els, sources } = setup();
    sources.begin('a', track({ final: '/f?asset=final', stream: null }));
    sources.commitOnReady('a');
    sources.unload('a');
    expect(els.a.paused).toBe(true);
    expect(els.a.src).toBe('');
    expect(sources.committedKind('a')).toBeNull();

    sources.begin('b', track({ final: '/g?asset=final', stream: null }));
    sources.clear('b');
    expect(sources.committedKind('b')).toBeNull();
    expect(els.b.paused).toBe(false); // clear touches bookkeeping only
  });
});

// Online too, a Track this device stores plays from the device: its stored
// copy is the local final, so it leads the ladder, and the pinned server
// sources stay behind it for a copy that will not load.
describe('DeckSources with a stored copy on this device', () => {
  const pinned = { final: '/f?asset=final', stream: '/f?asset=stream' };

  it('loads the stored copy first and commits it as the final', async () => {
    const { els, sources } = setup({ tr: new Blob(['stored bytes']) });
    expect(sources.begin('a', track(pinned))).toBe(true);
    expect(await served(els.a.src)).toBe('stored bytes');
    expect(sources.commitOnReady('a')).toBe(true);
    expect(sources.committedKind('a')).toBe('final');
  });

  it('streams a Track the device does not store', () => {
    const { els, sources } = setup({ other: new Blob(['stored bytes']) });
    sources.begin('a', track(pinned));
    expect(els.a.src).toBe('/f?asset=final');
  });

  it('steps down to the pinned sources when the stored copy will not load, and lets it go', async () => {
    const { els, sources } = setup({ tr: new Blob(['stored bytes']) });
    sources.begin('a', track(pinned));
    const storedUrl = els.a.src;
    expect(sources.stepDown('a')).toBe(true);
    expect(els.a.src).toBe('/f?asset=final');
    expect(await served(storedUrl)).toBeNull();
  });

  it('lets the stored copy go once its deck no longer carries the Track', async () => {
    const { els, sources } = setup({ tr: new Blob(['stored bytes']) });
    const leaves = [
      () => sources.unload('a'),
      () => sources.clear('a'),
      () => sources.begin('a', { ...track(pinned), trackId: 'next' }),
    ];
    for (const leave of leaves) {
      sources.begin('a', track(pinned));
      const storedUrl = els.a.src;
      leave();
      expect(await served(storedUrl)).toBeNull();
    }
  });

  it('keeps the copy the other deck still plays', async () => {
    const { els, sources } = setup({ tr: new Blob(['stored bytes']) });
    sources.begin('a', track(pinned));
    sources.begin('b', track(pinned));
    sources.unload('a');
    expect(await served(els.b.src)).toBe('stored bytes');
    sources.dispose();
    expect(await served(els.b.src)).toBeNull();
  });
});
