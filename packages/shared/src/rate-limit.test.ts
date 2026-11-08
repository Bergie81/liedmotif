import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';

/** A controllable clock so windows advance deterministically (no real time). */
function fakeClock(start = 1_000_000) {
  let nowMs = start;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('createRateLimiter (fixed window)', () => {
  it('allows requests up to the limit, then blocks', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-a').allowed).toBe(true);

    const blocked = limiter.check('ip-a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks each key independently', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-b').allowed).toBe(true); // different key, own budget
    expect(limiter.check('ip-a').allowed).toBe(false);
  });

  it('resets after the window elapses', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-a').allowed).toBe(false);

    clock.advance(60_001);
    const afterWindow = limiter.check('ip-a');
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(0); // limit 1, this consumed it
  });

  it('reports remaining budget within a window', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, now: clock.now });
    expect(limiter.check('ip-a').remaining).toBe(4);
    expect(limiter.check('ip-a').remaining).toBe(3);
  });

  it('evicts expired windows so caller-controlled keys cannot grow the map forever', () => {
    const clock = fakeClock();
    // maxKeys 2: with eviction broken, the third distinct key would be refused.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now, maxKeys: 2 });
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-b').allowed).toBe(true);

    // Both windows expire; fresh keys must be admitted again (expired state evicted).
    clock.advance(60_001);
    expect(limiter.check('ip-c').allowed).toBe(true);
    expect(limiter.check('ip-d').allowed).toBe(true);
  });

  it('fails closed for new keys when the map is full of live windows', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, now: clock.now, maxKeys: 2 });
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-b').allowed).toBe(true);

    const refused = limiter.check('ip-new');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    // Existing keys keep their budget — the cap never evicts live windows.
    expect(limiter.check('ip-a').allowed).toBe(true);
  });

  it('peek fails closed for new keys when the map is full of live windows', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, now: clock.now, maxKeys: 2 });
    limiter.check('ip-a');
    limiter.check('ip-b');

    // A fresh key cannot be admitted, so peek must not report it as allowed —
    // otherwise a saturated map would wave every untracked caller through.
    const refused = limiter.peek('ip-new');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    // Tracked keys still peek their real budget.
    expect(limiter.peek('ip-a').allowed).toBe(true);

    // Once the live windows expire, fresh keys are admitted again.
    clock.advance(60_001);
    expect(limiter.peek('ip-new').allowed).toBe(true);
  });

  it('refunds a consumed unit without ever handing out more than the limit', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });

    // A caller that consumes up front and refunds a free outcome must end the
    // window exactly where it started — otherwise legitimate use locks itself out.
    limiter.check('ip-a');
    limiter.refund('ip-a');
    expect(limiter.peek('ip-a').remaining).toBe(2);

    // A refund with nothing consumed must not credit budget the window never had.
    limiter.refund('ip-a');
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-a').allowed).toBe(false);
  });

  it('peek reports the current budget without consuming it', () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });

    // A fresh key has its full budget, and peeking does not open a window.
    expect(limiter.peek('ip-a')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(limiter.peek('ip-a').remaining).toBe(2);

    limiter.check('ip-a');
    expect(limiter.peek('ip-a').remaining).toBe(1);

    limiter.check('ip-a');
    const exhausted = limiter.peek('ip-a');
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.retryAfterMs).toBeGreaterThan(0);

    // After the window elapses the key is fresh again.
    clock.advance(60_001);
    expect(limiter.peek('ip-a').allowed).toBe(true);
  });
});
