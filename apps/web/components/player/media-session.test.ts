import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindMediaSessionActions } from './media-session';

// The `seekto` binding: binds when the caller
// provides it, adapts the details-callback shape (the transport actions stay
// zero-arg), guards only the SHAPE of the UA-supplied `seekTime` — numeric
// values pass through untouched, non-finite included, because
// `resolveSeekTarget` in the controller funnel is the single validation
// owner — unbinds cleanly, and never throws on a browser that rejects the
// action.

type BoundHandler = ((details?: { seekTime?: unknown }) => void) | null;

function fakeMediaSession(over: { rejectActions?: ReadonlySet<string> } = {}) {
  const bound = new Map<string, BoundHandler>();
  const ms = {
    metadata: null as unknown,
    setActionHandler: vi.fn((action: string, handler: BoundHandler) => {
      if (over.rejectActions?.has(action)) throw new TypeError('unsupported action');
      bound.set(action, handler);
    }),
  };
  vi.stubGlobal('navigator', { mediaSession: ms });
  return { ms, bound };
}

function transportHandlers() {
  return { play: vi.fn(), pause: vi.fn(), nexttrack: vi.fn(), previoustrack: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bindMediaSessionActions seekto', () => {
  it('binds seekto when provided and adapts the details-callback shape', () => {
    const { bound } = fakeMediaSession();
    const seekto = vi.fn();
    bindMediaSessionActions({ ...transportHandlers(), seekto });
    bound.get('seekto')?.({ seekTime: 42.5 });
    expect(seekto).toHaveBeenCalledTimes(1);
    expect(seekto).toHaveBeenCalledWith(42.5);
  });

  it('does not bind seekto when the handler is omitted', () => {
    const { bound } = fakeMediaSession();
    bindMediaSessionActions(transportHandlers());
    expect(bound.has('seekto')).toBe(false);
  });

  it('ignores a missing or non-numeric seekTime (shape guard only)', () => {
    const { bound } = fakeMediaSession();
    const seekto = vi.fn();
    bindMediaSessionActions({ ...transportHandlers(), seekto });
    bound.get('seekto')?.();
    bound.get('seekto')?.({});
    bound.get('seekto')?.({ seekTime: '12' });
    bound.get('seekto')?.({ seekTime: null });
    expect(seekto).not.toHaveBeenCalled();
  });

  it('passes numeric seekTime through UNTOUCHED — non-finite included (the funnel validates)', () => {
    const { bound } = fakeMediaSession();
    const seekto = vi.fn();
    bindMediaSessionActions({ ...transportHandlers(), seekto });
    bound.get('seekto')?.({ seekTime: Number.NaN });
    bound.get('seekto')?.({ seekTime: Number.POSITIVE_INFINITY });
    bound.get('seekto')?.({ seekTime: -7 });
    expect(seekto.mock.calls.map(([value]) => value)).toEqual([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -7,
    ]);
  });

  it('unbinding clears the seekto handler', () => {
    const { ms } = fakeMediaSession();
    const unbind = bindMediaSessionActions({ ...transportHandlers(), seekto: vi.fn() });
    unbind();
    expect(ms.setActionHandler).toHaveBeenCalledWith('seekto', null);
  });

  it('a browser rejecting seekto never breaks binding or unbinding', () => {
    const { ms, bound } = fakeMediaSession({ rejectActions: new Set(['seekto']) });
    const handlers = { ...transportHandlers(), seekto: vi.fn() };
    let unbind: (() => void) | undefined;
    expect(() => {
      unbind = bindMediaSessionActions(handlers);
    }).not.toThrow();
    expect(() => unbind?.()).not.toThrow();
    // The supported transport actions still bound around the rejection.
    expect(bound.has('play')).toBe(true);
    expect(bound.has('nexttrack')).toBe(true);
    expect(ms.setActionHandler).toHaveBeenCalledWith('seekto', expect.any(Function));
  });
});
