import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerEngine } from './audio-engine';
import { BufferDecks } from './buffer-decks';

// The buffer transport against a stubbed AudioContext: decode caching
// of pinned final bytes, recreated-per-start source nodes, pause/resume via
// stop-record-recreate, deliberate stop vs natural `onended` (stale-generation
// guarded), context-clock position bookkeeping, and the current+next decode
// retention policy.

interface FakeSource {
  buffer: unknown;
  playbackRate: { value: number };
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  onended: (() => void) | null;
  started: Array<{ when: number; offset: number }>;
  stopped: number;
  connectedTo: unknown[];
}

function fakeSource(): FakeSource & AudioBufferSourceNode {
  const src: FakeSource = {
    buffer: null,
    playbackRate: { value: 1 },
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    onended: null,
    started: [],
    stopped: 0,
    connectedTo: [],
  };
  return Object.assign(src, {
    connect(dest: unknown) {
      src.connectedTo.push(dest);
      return dest;
    },
    start(when = 0, offset = 0) {
      src.started.push({ when, offset });
    },
    stop() {
      src.stopped += 1;
    },
    disconnect() {},
  }) as unknown as FakeSource & AudioBufferSourceNode;
}

class FakeContext {
  currentTime = 0;
  sources: FakeSource[] = [];
  decodeResult: 'ok' | 'reject' = 'ok';
  decodeCalls = 0;
  failNextCreate = false;
  createBufferSource = () => {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new DOMException('context lost', 'InvalidStateError');
    }
    const src = fakeSource();
    this.sources.push(src as unknown as FakeSource);
    return src;
  };
  decodeAudioData = (_bytes: ArrayBuffer) => {
    this.decodeCalls += 1;
    return this.decodeResult === 'ok'
      ? Promise.resolve({
          duration: 30,
          sampleRate: 48000,
          getChannelData: () => Float32Array.from([1, 1, 0.5, 0.5]),
        } as unknown as AudioBuffer)
      : Promise.reject(new DOMException('EncodingError'));
  };
}

const deckInput = { input: true };

function makeEngine(ctx: FakeContext | null): () => PlayerEngine | null {
  const engine = {
    context: () => ctx,
    deckInput: () => (ctx ? deckInput : null),
  } as unknown as PlayerEngine;
  return () => engine;
}

function track(id: string) {
  return { trackId: id, assets: { final: `/api/audio/${id}?asset=final`, stream: null } };
}

describe('BufferDecks', () => {
  let ctx: FakeContext;
  let decks: BufferDecks;
  let naturalEnds: Array<{ deck: string; position: number }>;
  let fetchCalls: string[];
  let fetchSignals: Array<AbortSignal | undefined>;
  let fetchOk: boolean;

  beforeEach(() => {
    ctx = new FakeContext();
    naturalEnds = [];
    fetchCalls = [];
    fetchSignals = [];
    fetchOk = true;
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => {
      fetchCalls.push(url);
      fetchSignals.push(init?.signal);
      return Promise.resolve({
        ok: fetchOk,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
    });
    decks = new BufferDecks(makeEngine(ctx), (deck, position) =>
      naturalEnds.push({ deck, position }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes pinned final bytes once per track (cached across calls)', async () => {
    expect(await decks.ensureDecoded(track('t1'))).toBe(true);
    expect(await decks.ensureDecoded(track('t1'))).toBe(true);
    expect(fetchCalls).toEqual(['/api/audio/t1?asset=final']);
    expect(ctx.decodeCalls).toBe(1);
    expect(decks.isDecoded('t1')).toBe(true);
  });

  it("decodes a Track's stored copy on this device without fetching it", async () => {
    const decoded: ArrayBuffer[] = [];
    const decode = ctx.decodeAudioData;
    ctx.decodeAudioData = (bytes) => {
      decoded.push(bytes);
      return decode(bytes);
    };
    const stored = new Blob(['stored final']);
    decks = new BufferDecks(
      makeEngine(ctx),
      () => undefined,
      (trackId) => (trackId === 't1' ? stored : null),
    );
    expect(await decks.ensureDecoded(track('t1'))).toBe(true);
    expect(fetchCalls).toEqual([]);
    expect(new TextDecoder().decode(decoded[0])).toBe('stored final');
  });

  it('decodes the pinned final when the stored copy will not read', async () => {
    const unreadable = new Blob(['gone']);
    unreadable.arrayBuffer = () => Promise.reject(new DOMException('NotReadableError'));
    decks = new BufferDecks(
      makeEngine(ctx),
      () => undefined,
      () => unreadable,
    );
    expect(await decks.ensureDecoded(track('t1'))).toBe(true);
    expect(fetchCalls).toEqual(['/api/audio/t1?asset=final']);
  });

  it('a failed fetch is NOT cached as success — a later edge retries', async () => {
    fetchOk = false;
    expect(await decks.ensureDecoded(track('t1'))).toBe(false);
    expect(decks.isDecoded('t1')).toBe(false);
    fetchOk = true;
    expect(await decks.ensureDecoded(track('t1'))).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  it('a decode rejection reports false (element-deck fallback) without caching', async () => {
    ctx.decodeResult = 'reject';
    expect(await decks.ensureDecoded(track('t1'))).toBe(false);
    ctx.decodeResult = 'ok';
    expect(await decks.ensureDecoded(track('t1'))).toBe(true);
  });

  it('a track without a pinned final never decodes', async () => {
    expect(await decks.ensureDecoded({ trackId: 'x', assets: { final: null, stream: '/s' } })).toBe(
      false,
    );
    expect(fetchCalls).toEqual([]);
  });

  it('startAtTime schedules a recreated source sample-accurately with the locked rate', async () => {
    await decks.ensureDecoded(track('t1'));
    ctx.currentTime = 100;
    expect(decks.startAtTime('a', 't1', 105.25, 0, 1.01)).toBe(true);
    const src = ctx.sources[0]!;
    expect(src.started).toEqual([{ when: 105.25, offset: 0 }]);
    expect(src.playbackRate.value).toBeCloseTo(1.01);
    expect(src.connectedTo[0]).toBe(deckInput);
    expect(decks.carrying('a')).toBe(true);
    expect(decks.trackId('a')).toBe('t1');
  });

  it('refuses to start an undecoded track (caller falls back to the element deck)', () => {
    expect(decks.startAtTime('a', 'never-decoded', 1, 0, 1)).toBe(false);
    expect(decks.carrying('a')).toBe(false);
  });

  it('position advances on the context clock at the locked rate and holds while paused', async () => {
    await decks.ensureDecoded(track('t1'));
    ctx.currentTime = 100;
    decks.startAtTime('a', 't1', 100, 2, 1.01);
    ctx.currentTime = 110;
    expect(decks.positionSeconds('a')).toBeCloseTo(2 + 10 * 1.01, 10);

    decks.pause('a');
    expect(ctx.sources[0]!.stopped).toBe(1);
    ctx.currentTime = 200;
    expect(decks.positionSeconds('a')).toBeCloseTo(2 + 10 * 1.01, 10);

    // Resume recreates a source from the recorded offset at the same rate.
    decks.resume('a');
    const resumed = ctx.sources[1]!;
    expect(resumed.started[0]!.when).toBe(200);
    expect(resumed.started[0]!.offset).toBeCloseTo(2 + 10 * 1.01, 10);
    expect(resumed.playbackRate.value).toBeCloseTo(1.01);
    ctx.currentTime = 201;
    expect(decks.positionSeconds('a')).toBeCloseTo(2 + 10 * 1.01 + 1.01, 10);
  });

  it('a natural source end fires onNaturalEnd once, at the DECODED duration; a deliberate stop never does', async () => {
    await decks.ensureDecoded(track('t1'));
    decks.startAtTime('a', 't1', 0, 0, 1);
    ctx.sources[0]!.onended?.();
    // The report position is the buffer's own end — never the carrier clock.
    expect(naturalEnds).toEqual([{ deck: 'a', position: 30 }]);
    expect(decks.carrying('a')).toBe(false);

    decks.startAtTime('a', 't1', 10, 0, 1);
    decks.stop('a');
    ctx.sources[1]!.onended?.();
    expect(naturalEnds).toEqual([{ deck: 'a', position: 30 }]);
  });

  it('a failed resume rolls back to paused and keeps the recorded offset (fallback-ready)', async () => {
    await decks.ensureDecoded(track('t1'));
    ctx.currentTime = 100;
    decks.startAtTime('a', 't1', 100, 0, 1);
    ctx.currentTime = 110;
    decks.pause('a');
    ctx.failNextCreate = true;
    expect(decks.resume('a')).toBe(false);
    expect(decks.state('a')).toBe('paused');
    expect(decks.positionSeconds('a')).toBeCloseTo(10, 10);
    // A later resume (context recovered) succeeds from the same offset.
    ctx.currentTime = 200;
    expect(decks.resume('a')).toBe(true);
    expect(ctx.sources[1]!.started[0]!.offset).toBeCloseTo(10, 10);
  });

  it('retainOnly ABORTS the fetch of a dropped in-flight decode (stale-decode cancellation)', () => {
    void decks.ensureDecoded(track('t1'));
    expect(fetchSignals[0]?.aborted).toBe(false);
    decks.retainOnly(['other']);
    expect(fetchSignals[0]?.aborted).toBe(true);
  });

  it('re-requesting an in-flight EVICTED decode reuses it — decodes of one track never overlap', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', (url: string) => {
      fetchCalls.push(url);
      return new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
      });
    });
    const first = decks.ensureDecoded(track('t1'));
    decks.retainOnly([]); // queue replacement mid-flight → tombstone
    const second = decks.ensureDecoded(track('t1')); // re-wanted before settle
    release!();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // ONE fetch+decode served both requests — never two concurrent decodes.
    expect(fetchCalls).toHaveLength(1);
    expect(decks.isDecoded('t1')).toBe(true);
  });

  it('an ABORTED tombstone re-request retries once after the dead attempt settles (never overlapping)', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const okResponse = { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
    vi.stubGlobal('fetch', (url: string, init?: { signal?: AbortSignal }) => {
      fetchCalls.push(url);
      calls += 1;
      const signal = init?.signal;
      if (calls > 1) return Promise.resolve(okResponse);
      return new Promise((resolve, reject) => {
        release = () =>
          signal?.aborted ? reject(new DOMException('aborted', 'AbortError')) : resolve(okResponse);
      });
    });
    void decks.ensureDecoded(track('t1'));
    decks.retainOnly([]); // aborts the fetch, tombstones the entry
    const rewanted = decks.ensureDecoded(track('t1'));
    // Nothing overlaps while the dead attempt is still in flight.
    expect(fetchCalls).toHaveLength(1);
    release!(); // the aborted attempt settles dead → the retry runs
    expect(await rewanted).toBe(true);
    expect(fetchCalls).toHaveLength(2);
    expect(decks.isDecoded('t1')).toBe(true);
  });

  it('a stale decode settling AFTER its eviction never re-enters the cache', async () => {
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', () => {
      return new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
      });
    });
    const pending = decks.ensureDecoded(track('t1'));
    decks.retainOnly([]); // queue replacement mid-flight
    release!();
    expect(await pending).toBe(false);
    expect(decks.isDecoded('t1')).toBe(false);
  });

  it('a STALE onended from a replaced source is ignored (stop → restart race)', async () => {
    await decks.ensureDecoded(track('t1'));
    decks.startAtTime('a', 't1', 0, 0, 1);
    const stale = ctx.sources[0]!;
    decks.stop('a');
    decks.startAtTime('a', 't1', 5, 0, 1);
    stale.onended?.();
    expect(naturalEnds).toEqual([]);
    expect(decks.carrying('a')).toBe(true);
  });

  it('pause → onended echo of the stopped node is not a natural end', async () => {
    await decks.ensureDecoded(track('t1'));
    decks.startAtTime('a', 't1', 0, 0, 1);
    decks.pause('a');
    ctx.sources[0]!.onended?.();
    expect(naturalEnds).toEqual([]);
    expect(decks.carrying('a')).toBe(true);
  });

  it('retainOnly holds at most the retained tracks (release on advance)', async () => {
    await decks.ensureDecoded(track('t1'));
    await decks.ensureDecoded(track('t2'));
    await decks.ensureDecoded(track('t3'));
    decks.retainOnly(['t2', 't3']);
    expect(decks.isDecoded('t1')).toBe(false);
    expect(decks.isDecoded('t2')).toBe(true);
    expect(decks.isDecoded('t3')).toBe(true);
  });

  describe('seekTo', () => {
    it('while playing: stops the old source, recreates one at the target offset, reports the target immediately', async () => {
      await decks.ensureDecoded(track('t1'));
      ctx.currentTime = 100;
      decks.startAtTime('a', 't1', 100, 0, 1);
      ctx.currentTime = 110;

      expect(decks.seekTo('a', 5)).toBe(true);
      const old = ctx.sources[0]!;
      expect(old.stopped).toBe(1);
      const recreated = ctx.sources[1]!;
      expect(recreated.started).toEqual([{ when: 110, offset: 5 }]);
      expect(decks.positionSeconds('a')).toBeCloseTo(5, 10);
      expect(decks.state('a')).toBe('playing');

      // The generation bumped: the stopped node's late `onended` never counts.
      old.onended?.();
      expect(naturalEnds).toEqual([]);
      expect(decks.carrying('a')).toBe(true);
    });

    it('while paused: rewrites the recorded offset only (no source created); a later resume starts there', async () => {
      await decks.ensureDecoded(track('t1'));
      ctx.currentTime = 100;
      decks.startAtTime('a', 't1', 100, 0, 1);
      ctx.currentTime = 104;
      decks.pause('a');

      expect(decks.seekTo('a', 12)).toBe(true);
      expect(ctx.sources).toHaveLength(1);
      expect(decks.state('a')).toBe('paused');
      expect(decks.positionSeconds('a')).toBeCloseTo(12, 10);

      ctx.currentTime = 200;
      expect(decks.resume('a')).toBe(true);
      expect(ctx.sources[1]!.started).toEqual([{ when: 200, offset: 12 }]);
    });

    it('on an idle/empty deck returns false and changes nothing', () => {
      expect(decks.seekTo('a', 5)).toBe(false);
      expect(ctx.sources).toHaveLength(0);
      expect(decks.carrying('a')).toBe(false);
    });

    it('clamps the target to [0, buffer.duration] against its own decoded truth', async () => {
      await decks.ensureDecoded(track('t1'));
      ctx.currentTime = 100;
      decks.startAtTime('a', 't1', 100, 0, 1);

      expect(decks.seekTo('a', 999)).toBe(true);
      expect(ctx.sources[1]!.started[0]!.offset).toBe(30);
      expect(decks.seekTo('a', -5)).toBe(true);
      expect(ctx.sources[2]!.started[0]!.offset).toBe(0);
      expect(decks.positionSeconds('a')).toBeCloseTo(0, 10);
    });

    it('rejects a non-finite target before any side effect (transport self-defense, independent of the caller)', async () => {
      await decks.ensureDecoded(track('t1'));
      ctx.currentTime = 100;
      decks.startAtTime('a', 't1', 100, 0, 1);

      // While playing: the deck must keep playing — never stopped-then-stranded.
      expect(decks.seekTo('a', Number.NaN)).toBe(false);
      expect(ctx.sources[0]!.stopped).toBe(0);
      expect(decks.state('a')).toBe('playing');

      // While paused: the recorded offset must survive untouched.
      ctx.currentTime = 104;
      decks.pause('a');
      expect(decks.seekTo('a', Number.POSITIVE_INFINITY)).toBe(false);
      expect(decks.positionSeconds('a')).toBeCloseTo(4, 10);
      ctx.currentTime = 200;
      expect(decks.resume('a')).toBe(true);
      expect(ctx.sources[1]!.started).toEqual([{ when: 200, offset: 4 }]);
    });

    it('a failed source recreation on the playing path rolls back to paused with the TARGET offset recorded', async () => {
      await decks.ensureDecoded(track('t1'));
      ctx.currentTime = 100;
      decks.startAtTime('a', 't1', 100, 0, 1);
      ctx.currentTime = 110;
      ctx.failNextCreate = true;

      expect(decks.seekTo('a', 7)).toBe(false);
      expect(decks.state('a')).toBe('paused');
      // The caller falls back to the element path AT THE SOUGHT POSITION.
      expect(decks.positionSeconds('a')).toBeCloseTo(7, 10);
      // A later resume (context recovered) succeeds from the target.
      ctx.currentTime = 200;
      expect(decks.resume('a')).toBe(true);
      expect(ctx.sources[1]!.started[0]!.offset).toBeCloseTo(7, 10);
    });

    it('the preserved playbackRate carries through the recreated clock (a beat-locked nudge survives a seek)', async () => {
      await decks.ensureDecoded(track('t1'));
      ctx.currentTime = 100;
      decks.startAtTime('a', 't1', 100, 0, 1.01);
      ctx.currentTime = 110;

      decks.seekTo('a', 5);
      expect(ctx.sources[1]!.playbackRate.value).toBeCloseTo(1.01);
      ctx.currentTime = 112;
      expect(decks.positionSeconds('a')).toBeCloseTo(5 + 2 * 1.01, 10);
    });
  });

  it('supported() is false without a live context (decode API missing)', () => {
    const without = new BufferDecks(makeEngine(null), () => undefined);
    expect(without.supported()).toBe(false);
    expect(decks.supported()).toBe(true);
  });

  describe('section loop', () => {
    const region = { startSeconds: 10, endSeconds: 14 };
    const lastSource = () => ctx.sources[ctx.sources.length - 1]!;

    beforeEach(async () => {
      await decks.ensureDecoded(track('t1'));
      decks.startAtTime('a', 't1', 0, 0, 1);
      ctx.currentTime = 2;
    });

    it('recreates the source repeating the region, starting where asked', () => {
      expect(decks.setLoop('a', region, 10)).toBe(true);
      const source = lastSource();
      expect(ctx.sources).toHaveLength(2);
      expect(ctx.sources[0]!.stopped).toBe(1);
      expect(source.loop).toBe(true);
      expect(source.loopStart).toBe(10);
      expect(source.loopEnd).toBe(14);
      expect(source.started).toEqual([{ when: 2, offset: 10 }]);
      expect(naturalEnds).toEqual([]);
    });

    it('lands the loop points on whole sample frames', () => {
      decks.setLoop('a', { startSeconds: 1.00001, endSeconds: 3.33333 }, 1.00001);
      expect(lastSource().loopStart * 48000).toBeCloseTo(48000, 6);
      expect(lastSource().loopEnd * 48000).toBeCloseTo(160000, 6);
    });

    it('reports the wrapped position while it repeats', () => {
      decks.setLoop('a', region, 10);
      ctx.currentTime = 2 + 4 * 3 + 1;
      expect(decks.positionSeconds('a')).toBeCloseTo(11);
    });

    it('keeps repeating across pause and resume, from the wrapped position', () => {
      decks.setLoop('a', region, 10);
      ctx.currentTime = 2 + 4 + 1;
      decks.pause('a');
      expect(decks.positionSeconds('a')).toBeCloseTo(11);
      ctx.currentTime = 50;
      expect(decks.resume('a')).toBe(true);
      const source = lastSource();
      expect(source.loop).toBe(true);
      expect(source.started).toEqual([{ when: 50, offset: expect.closeTo(11) as number }]);
      ctx.currentTime = 50 + 4;
      expect(decks.positionSeconds('a')).toBeCloseTo(11);
    });

    it('keeps repeating through a seek inside the region', () => {
      decks.setLoop('a', region, 10);
      expect(decks.seekTo('a', 12)).toBe(true);
      expect(lastSource().loop).toBe(true);
      ctx.currentTime = 2 + 3;
      expect(decks.positionSeconds('a')).toBeCloseTo(11);
    });

    it('refuses a start at or past the region end, which would run on silently', () => {
      expect(decks.setLoop('a', region, 14)).toBe(false);
      expect(lastSource().loop).toBe(false);
    });

    it('takes a region while paused and starts repeating on resume', () => {
      decks.pause('a');
      expect(decks.setLoop('a', region, 12)).toBe(true);
      expect(ctx.sources).toHaveLength(1);
      expect(decks.positionSeconds('a')).toBe(12);
      decks.resume('a');
      expect(lastSource().loop).toBe(true);
      expect(lastSource().started[0]!.offset).toBe(12);
    });

    it('clearing lets the same source play on past the region without a restart', () => {
      decks.setLoop('a', region, 10);
      ctx.currentTime = 2 + 4 + 1;
      const source = lastSource();
      const count = ctx.sources.length;
      decks.clearLoop('a');
      expect(ctx.sources).toHaveLength(count);
      expect(source.loop).toBe(false);
      expect(source.stopped).toBe(0);
      expect(decks.positionSeconds('a')).toBeCloseTo(11);
      ctx.currentTime += 5;
      expect(decks.positionSeconds('a')).toBeCloseTo(16);
    });

    it('a natural end counts again once the loop is cleared', () => {
      decks.setLoop('a', region, 10);
      decks.clearLoop('a');
      lastSource().onended?.();
      expect(naturalEnds).toEqual([{ deck: 'a', position: 30 }]);
    });

    it('a failed recreation leaves the deck paused at the target with no loop', () => {
      ctx.failNextCreate = true;
      expect(decks.setLoop('a', region, 10)).toBe(false);
      expect(decks.state('a')).toBe('paused');
      expect(decks.positionSeconds('a')).toBe(10);
      decks.resume('a');
      expect(lastSource().loop).toBe(false);
    });

    it('refuses a deck carrying nothing', () => {
      expect(decks.setLoop('b', region, 10)).toBe(false);
    });

    it('refuses a region with no length', () => {
      expect(decks.setLoop('a', { startSeconds: 10, endSeconds: 10 }, 10)).toBe(false);
      expect(ctx.sources).toHaveLength(1);
    });

    it('a new start after stop does not inherit the region', () => {
      decks.setLoop('a', region, 10);
      decks.stop('a');
      decks.startAtTime('a', 't1', 5, 0, 1);
      expect(lastSource().loop).toBe(false);
    });
  });

  describe('parkAt', () => {
    it('carries a decoded Track paused at the offset, with no source yet', async () => {
      await decks.ensureDecoded(track('t1'));
      expect(decks.parkAt('a', 't1', 12)).toBe(true);
      expect(decks.state('a')).toBe('paused');
      expect(decks.carrying('a')).toBe(true);
      expect(decks.positionSeconds('a')).toBe(12);
      expect(ctx.sources).toHaveLength(0);
    });

    it('starts from that offset on resume', async () => {
      await decks.ensureDecoded(track('t1'));
      decks.parkAt('a', 't1', 12);
      ctx.currentTime = 7;
      expect(decks.resume('a')).toBe(true);
      expect(ctx.sources[0]!.started).toEqual([{ when: 7, offset: 12 }]);
    });

    it('refuses an undecoded Track', () => {
      expect(decks.parkAt('a', 't1', 12)).toBe(false);
      expect(decks.carrying('a')).toBe(false);
    });
  });

  it('reads the waveform and true length from the decoded Track, and null before it', async () => {
    expect(decks.waveform('t1', 2)).toBeNull();
    await decks.ensureDecoded(track('t1'));
    expect(decks.waveform('t1', 2)).toEqual({ bars: [1, 0.25], durationSeconds: 30 });
  });

  it('durationSeconds reports the decoded buffer length for a carrying deck', async () => {
    await decks.ensureDecoded(track('t1'));
    decks.startAtTime('a', 't1', 0, 0, 1);
    expect(decks.durationSeconds('a')).toBe(30);
    expect(decks.durationSeconds('b')).toBeNull();
  });
});
