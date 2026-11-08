// The session-start autoplay handoff. The
// "start session" CLICK is the user gesture, but the player (and its deck
// elements) mounts only after the create request resolves — so the gesture
// primes an engine (context created + unlocked) into a module slot, and the
// player adopts it when it first needs one. Engine creation stays OUT of
// mount effects (the StrictMode double-mount safety): the slot is filled by
// a gesture handler and consumed at most once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptPrimedPlayerEngine, primePlayerAutoplay } from './autoplay-arm';

class FakeAudioContext {
  static created = 0;
  static last: FakeAudioContext | null = null;
  constructor() {
    FakeAudioContext.created += 1;
    FakeAudioContext.last = this;
  }
  state = 'suspended';
  resumeCalls = 0;
  resume() {
    this.resumeCalls += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };
  FakeAudioContext.created = 0;
  FakeAudioContext.last = null;
});
afterEach(() => {
  // Drain the slot so one test's primed engine never leaks into the next.
  adoptPrimedPlayerEngine();
  delete (globalThis as { window?: unknown }).window;
});

describe('primePlayerAutoplay / adoptPrimedPlayerEngine', () => {
  it('priming creates + unlocks a context; the engine is adopted exactly once', () => {
    primePlayerAutoplay();
    expect(FakeAudioContext.created).toBe(1);
    expect(FakeAudioContext.last!.resumeCalls).toBe(1);

    const engine = adoptPrimedPlayerEngine();
    expect(engine).not.toBeNull();
    // The slot is consumed: a later mount (StrictMode remount, another
    // session) must not adopt a disposed or shared engine.
    expect(adoptPrimedPlayerEngine()).toBeNull();
  });

  it('re-priming before adoption keeps ONE primed engine (no context pile-up)', () => {
    primePlayerAutoplay();
    primePlayerAutoplay();
    expect(FakeAudioContext.created).toBe(1);
    expect(adoptPrimedPlayerEngine()).not.toBeNull();
    expect(adoptPrimedPlayerEngine()).toBeNull();
  });

  it('adopting with nothing primed yields null (the caller constructs lazily)', () => {
    expect(adoptPrimedPlayerEngine()).toBeNull();
  });
});
