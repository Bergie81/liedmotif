// Tiny in-memory fixed-window rate limiter, shared by the unauthenticated web
// endpoints (setup validation/submit, login failures).
//
// It throttles the unauthenticated setup-validation routes (which
// reach out to provider APIs) so they can't be hammered. It is deliberately
// process-local — no Redis — which is the
// right scope for a single-instance self-hosted app. The clock is injectable so
// window behavior is tested deterministically without real time.
//
// SINGLE REPLICA is a load-bearing assumption: every window lives in this
// process's heap, so N replicas multiply each budget by N and a redeploy resets
// them all. Scaling the web process out means backing these windows with
// Postgres first — the limits are not shared state today.
//
// Keys are caller-controlled (client IPs), so the window map is bounded two ways:
// expired windows are swept on a once-per-window cadence, and a hard
// `maxKeys` cap FAILS CLOSED — when the map is full of live windows, brand-new
// keys are refused rather than growing memory or evicting an active attacker's
// count. Refusing new callers under key-flood pressure is the safe failure mode
// for endpoints that spend provider money or guard sign-in.

export interface RateLimiterOptions {
  /** Max allowed `check`s per key within a window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Hard cap on distinct tracked keys (new keys are refused at the cap). */
  maxKeys?: number;
}

export interface RateLimitResult {
  /** Whether this call is within the limit (and, for `check`, has consumed one unit). */
  allowed: boolean;
  /** Remaining budget in the current window after this call. */
  remaining: number;
  /** Milliseconds until the window resets (0 when budget remains). */
  retryAfterMs: number;
}

export interface RateLimiter {
  /** Record one hit for `key` and report whether it is allowed. */
  check(key: string): RateLimitResult;
  /** Report `key`'s current budget WITHOUT consuming any of it. */
  peek(key: string): RateLimitResult;
  /**
   * Give one consumed unit back to `key`'s live window. Pairs with a `check`
   * made BEFORE the outcome is known — consuming up front is the only way a
   * parallel burst cannot all clear the gate before the first hit records —
   * and returns the unit once the outcome turns out to be free.
   */
  refund(key: string): void;
}

interface WindowState {
  count: number;
  /** Wall-clock ms at which the current window resets. */
  resetAt: number;
}

/** Far more distinct keys (client IPs) than a single-admin instance ever sees. */
const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  const windows = new Map<string, WindowState>();
  let nextSweepAt = 0;

  /** Drop expired windows, amortized to one full pass per window length. */
  function sweep(current: number, force = false): void {
    if (!force && current < nextSweepAt) return;
    nextSweepAt = current + windowMs;
    for (const [key, state] of windows) {
      if (current >= state.resetAt) windows.delete(key);
    }
  }

  /**
   * Whether a NEW key can be admitted. At the cap, a forced sweep may free
   * room; if every window is live, refuse (fail closed) instead of growing the
   * map or evicting live state. Shared by check() and peek() so a saturated
   * map can never wave an untracked key through one path but not the other.
   */
  function hasRoomForNewKey(current: number): boolean {
    if (windows.size < maxKeys) return true;
    sweep(current, true);
    return windows.size < maxKeys;
  }

  return {
    check(key: string): RateLimitResult {
      const current = now();
      sweep(current);
      let state = windows.get(key);
      if (!state || current >= state.resetAt) {
        if (!state && !hasRoomForNewKey(current)) {
          return { allowed: false, remaining: 0, retryAfterMs: windowMs };
        }
        // Start (or roll over) the window for this key.
        state = { count: 0, resetAt: current + windowMs };
        windows.set(key, state);
      }

      const retryAfterMs = Math.max(0, state.resetAt - current);
      if (state.count >= limit) {
        return { allowed: false, remaining: 0, retryAfterMs };
      }
      state.count += 1;
      return { allowed: true, remaining: limit - state.count, retryAfterMs };
    },

    peek(key: string): RateLimitResult {
      const current = now();
      sweep(current);
      const state = windows.get(key);
      // No live window → a check would open a fresh one with the full budget —
      // but ONLY if the map has room (its later consuming check() could never
      // record a failure for a key that cannot be admitted).
      if (!state || current >= state.resetAt) {
        if (!state && !hasRoomForNewKey(current)) {
          return { allowed: false, remaining: 0, retryAfterMs: windowMs };
        }
        return { allowed: true, remaining: limit, retryAfterMs: 0 };
      }
      const retryAfterMs = Math.max(0, state.resetAt - current);
      if (state.count >= limit) {
        return { allowed: false, remaining: 0, retryAfterMs };
      }
      return { allowed: true, remaining: limit - state.count, retryAfterMs };
    },

    refund(key: string): void {
      const state = windows.get(key);
      // Only a live window with something on its count is refundable: an
      // expired one no longer holds the unit, and crediting an untouched window
      // would hand out budget it never spent.
      if (!state || now() >= state.resetAt || state.count === 0) return;
      state.count -= 1;
    },
  };
}
