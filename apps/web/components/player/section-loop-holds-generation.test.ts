// @vitest-environment jsdom

// A live Section loop buys nothing: it shares Loop Track's generation hold, and
// gives way when that hold would block something the listener asked for.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BufferDecks } from './buffer-decks';
import type { PlayableTrack } from './playable-track';
import { useLoopLease } from './use-loop-lease';
import { useSectionLoop, type SectionLoopDeps } from './use-section-loop';

const lease = vi.hoisted(() => ({ actions: [] as string[] }));

vi.mock('@/lib/http/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http/api-client')>()),
  applyLoopLease: vi.fn(async ({ action }: { action: string }) => {
    lease.actions.push(action);
    return {
      ok: true,
      data: {
        applied: true,
        held: action !== 'release',
        lease: { released: action === 'release' },
      },
    };
  }),
}));

beforeEach(() => {
  lease.actions = [];
});
afterEach(cleanup);

describe('the generation hold', () => {
  const mount = () => renderHook(() => useLoopLease('session-1', 'client-1')).result;

  it('acquires while a loop is live and releases when it ends', async () => {
    const api = mount();
    await act(async () => api.current.hold('section-loop', true));
    expect(lease.actions).toEqual(['acquire']);
    await act(async () => api.current.hold('section-loop', false));
    expect(lease.actions).toEqual(['acquire', 'release']);
  });

  it('does not ask again while the loop is only being redrawn', async () => {
    const api = mount();
    await act(async () => api.current.hold('section-loop', true));
    await act(async () => api.current.hold('section-loop', true));
    expect(lease.actions).toEqual(['acquire']);
  });

  it('keeps the hold when Loop Track lets go during a Section loop', async () => {
    const api = mount();
    await act(async () => api.current.hold('loop-track', true));
    await act(async () => api.current.hold('section-loop', true));
    lease.actions = [];
    await act(async () => api.current.hold('loop-track', false));
    expect(lease.actions).toEqual([]);
    await act(async () => api.current.hold('section-loop', false));
    expect(lease.actions).toEqual(['release']);
  });

  it('keeps the hold when a Section loop ends under Loop Track', async () => {
    const api = mount();
    await act(async () => api.current.hold('loop-track', true));
    await act(async () => api.current.hold('section-loop', true));
    await act(async () => api.current.hold('section-loop', false));
    expect(lease.actions).toEqual(['acquire']);
  });
});

describe('what ends a Section loop', () => {
  const REGION = { startSeconds: 10, endSeconds: 14 };
  const noop = () => undefined;
  const clearLoop = vi.fn();
  const holdGeneration = vi.fn();

  const deps: SectionLoopDeps = {
    activeDeck: () => 'a',
    activeTrack: () =>
      ({
        queueItemId: 'item-1',
        trackId: 'track-1',
        assets: { final: null, stream: null },
      }) as PlayableTrack,
    deckEl: () => ({ paused: false, loop: false }) as HTMLAudioElement,
    buffers: () =>
      ({
        ensureDecoded: async () => true,
        waveform: () => ({ bars: [1], durationSeconds: 30 }),
        carrying: () => true,
        setLoop: () => true,
        clearLoop,
      }) as unknown as BufferDecks,
    deviceAllows: () => true,
    muteElement: noop,
    abandonEdge: noop,
    carryOnOnElement: noop,
    syncCarrier: noop,
    syncPreparedTarget: noop,
    holdGeneration,
    positionMoved: noop,
    patch: noop,
    notice: noop,
  };
  const depsRef = { current: deps };

  async function looping() {
    const { result } = renderHook(() => useSectionLoop(depsRef));
    await act(async () => result.current.toggleTool());
    await act(async () => result.current.setRegion(REGION, 10));
    expect(result.current.region()).toEqual(REGION);
    clearLoop.mockClear();
    holdGeneration.mockClear();
    return result;
  }

  const snapshot = {
    revisionMoved: false,
    sessionStatus: 'active' as const,
    queueItemIds: new Set(['item-1']),
  };

  it('a Change Vibe, because the hold would block its new fill', async () => {
    const api = await looping();
    await act(async () => api.current.onQueueSnapshot({ ...snapshot, revisionMoved: true }));
    expect(api.current.region()).toBeNull();
    expect(clearLoop).toHaveBeenCalledOnce();
    expect(holdGeneration).toHaveBeenCalledWith(false);
  });

  it('the Session stopping', async () => {
    const api = await looping();
    await act(async () => api.current.onQueueSnapshot({ ...snapshot, sessionStatus: 'stopped' }));
    expect(clearLoop).toHaveBeenCalledOnce();
  });

  it('the looped Track leaving the Queue', async () => {
    const api = await looping();
    await act(async () =>
      api.current.onQueueSnapshot({ ...snapshot, queueItemIds: new Set(['other']) }),
    );
    expect(clearLoop).toHaveBeenCalledOnce();
  });

  it('a new final landing, so the audio never repeats a region the tool has dropped', async () => {
    const api = await looping();
    await act(async () => api.current.onTrackChanged('item-1', '/api/audio/track-1?asset=final'));
    expect(api.current.region()).toBeNull();
    expect(clearLoop).toHaveBeenCalledOnce();
    expect(holdGeneration).toHaveBeenCalledWith(false);
  });

  it('nothing else', async () => {
    const api = await looping();
    await act(async () => api.current.onQueueSnapshot(snapshot));
    expect(api.current.region()).toEqual(REGION);
    expect(clearLoop).not.toHaveBeenCalled();
  });

  it('never bothers a player with no loop', async () => {
    const { result } = renderHook(() => useSectionLoop(depsRef));
    clearLoop.mockClear();
    await act(async () => result.current.onQueueSnapshot({ ...snapshot, revisionMoved: true }));
    expect(clearLoop).not.toHaveBeenCalled();
  });
});
