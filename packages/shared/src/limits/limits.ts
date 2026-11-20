// The cost-limit money chokepoint. Spend is
// counted internally in provider calls (tasks/ProviderJobs) — the atomic unit of
// spend — and converted to tracks only for display. A cost-limit failure is
// precisely what degrades a running session to Session Repeat (the worker maps it
// to `generationStatus='repeat_cost_limit'`). Concurrency throttling and the
// manual-only policy are NOT modeled here — they are buffer-controller concerns
// that never trigger Session Repeat — so this stays a pure daily/monthly cap check.
//
// A submit is held to an ORDERED LIST of bounds, one per scope: the Admin's single
// instance bound, or a Member's own budget followed by the Members Pool. Order is
// precedence — the first bound that refuses is the one reported — so a Member who
// has spent their own budget is told that rather than being pointed at a shared
// limit they cannot influence. One list shape means every caller, every role, and
// both the admission and headroom questions share one code path.

/**
 * Which limit window binds. `day` and `month` are a rolling budget's — they
 * reset; `total` is a One-time budget's single window, which never does, so a
 * `total` refusal must never offer a rollover to wait for.
 */
export type CostLimitWindow = 'day' | 'month' | 'total';

/**
 * The one sentence every surface says for a used-up One-time budget: it names
 * the person who can raise the total, never a rollover, and falls back to
 * "the Admin" when the instance has no name to give.
 */
export function oneTimeBudgetUsedUpMessage(adminName: string | null): string {
  return `Your budget is used up. Ask ${adminName ?? 'the admin'} for more.`;
}

/**
 * Which bound a decision is about. `instance` is the Admin's own — and only —
 * bound; `member` and `pool` are the two a Member is held to. A
 * Member's own budget is something they spent and get back at rollover; the
 * shared Pool is something they cannot influence. Every refusal must say which.
 */
export type CostLimitScope = 'instance' | 'member' | 'pool';

/**
 * The half of the scope vocabulary that reaches the player and the stored session
 * row, where `null` means the refusal was not bound by a Member budget.
 */
export type MemberCostLimitScope = Exclude<CostLimitScope, 'instance'>;

/** Narrow a scope to what the session row and the player carry. */
export function memberBoundScope(scope: CostLimitScope): MemberCostLimitScope | null {
  return scope === 'instance' ? null : scope;
}

/** One window of a bound: its cap and the spend already counted against it. */
export interface BoundWindow {
  window: CostLimitWindow;
  /** The cap, in whatever unit the caller counts — tasks for music, covers for covers. */
  cap: number;
  /** Already spent in this window, in the same unit. */
  used: number;
}

/**
 * The counted spend of one bound: its windows, checked in order. A rolling
 * budget is `[day, month]`; a One-time budget is the single
 * `[total]` window, everything spent since its Grant against a total that never
 * renews. Non-empty by construction: a bound with no window would bound nothing.
 */
export type BoundWindows = readonly [BoundWindow, ...BoundWindow[]];

/** One named bound: the windows that define it and the spend counted against them. */
export interface CostBound {
  scope: CostLimitScope;
  windows: BoundWindows;
}

/**
 * One named window of a bound, or its first window when that name is absent: a
 * One-time bound's single `total` stands in for both windows of a readout that
 * is shaped for `day` and `month`.
 */
export function boundWindow(windows: BoundWindows, name: CostLimitWindow): BoundWindow {
  return windows.find((window) => window.window === name) ?? windows[0];
}

/**
 * The bounds a submit is held to, in refusal-precedence order. Non-empty by
 * construction: there is no role without at least one bound, so no caller and no
 * decision needs an "unbounded" case.
 */
export type CostBounds = readonly [CostBound, ...CostBound[]];

/** Result of a cost-limit check for submitting ONE more task. */
export type CostLimitDecision =
  { withinLimits: true } | { withinLimits: false; window: CostLimitWindow; scope: CostLimitScope };

/**
 * Which window of a single bound is exhausted, if any. A window is exhausted
 * when its already-spent count has reached the cap (so the *next* task would
 * exceed it). The first exhausted window in list order is reported — the day
 * before the month, the tighter, sooner-to-reset bound.
 */
function exhaustedWindow(windows: BoundWindows): CostLimitWindow | null {
  return windows.find((window) => window.used >= window.cap)?.window ?? null;
}

/**
 * Can one more task be submitted right now? Every bound must admit it, and the
 * first that refuses is the one reported — so the caller's bound order is the
 * refusal precedence.
 */
export function checkCostLimits(bounds: CostBounds): CostLimitDecision {
  for (const bound of bounds) {
    const window = exhaustedWindow(bound.windows);
    if (window) return { withinLimits: false, window, scope: bound.scope };
  }
  return { withinLimits: true };
}

/**
 * Remaining spend in ONE bound before its tightest window binds, in the unit
 * that bound is counted in (tasks for music, covers for covers). Never negative
 * (a window already over its cap contributes 0).
 */
export function remainingInBound(windows: BoundWindows): number {
  return Math.max(0, remainingIn(tightestWindow(windows)));
}

/**
 * A cap or remaining count as a readout carries it: `null` for an unbounded
 * window. A switched-off Admin ceiling resolves to an infinite cap, which no
 * count reaches and no readout can show.
 */
export function boundedOrNull(count: number): number | null {
  return Number.isFinite(count) ? count : null;
}

/** One music bound's remaining headroom in TRACKS, at the provider's yield per call. */
export function remainingHeadroomTracks(windows: BoundWindows, tracksPerCall: number): number {
  return remainingInBound(windows) * tracksPerCall;
}

function remainingIn(window: BoundWindow): number {
  return window.cap - window.used;
}

/**
 * The window a bound's headroom is measured in: the one with the least
 * remaining, and the earlier one on ties — the day over the month, the
 * sooner-to-reset window.
 */
function tightestWindow(windows: BoundWindows): BoundWindow {
  let tightest = windows[0];
  for (const window of windows) {
    if (remainingIn(window) < remainingIn(tightest)) tightest = window;
  }
  return tightest;
}

/** The creation-time headroom gate decision, in user-facing TRACK units. */
export interface CreationHeadroomDecision {
  /** True when a new session may be created (Start Session / More Like This). */
  allowed: boolean;
  /** Remaining headroom converted to tracks (`remainingHeadroomTracks`). */
  remainingTracks: number;
  /** The minimum tracks the decision was made against (`minHeadroomTracksToStartSession`). */
  minHeadroomTracks: number;
  /** The bound the headroom came from, so refusal copy can name what binds. */
  scope: CostLimitScope;
  /**
   * That bound's tighter window (the day on ties): `total` means a One-time
   * budget, whose refusal must not promise a rollover.
   */
  window: CostLimitWindow;
  /**
   * The window whose reset lets a refused Session start: the binding window,
   * or the window that would still refuse once every day window resets —
   * midnight alone then brings back too little. `total` there means no reset
   * helps: a One-time budget never renews.
   */
  resetWindow: CostLimitWindow;
  /**
   * That window's own cap in tracks (Infinity when unbounded). Below
   * `minHeadroomTracks`, no reset ever lets a Session start, so the refusal
   * must not promise one.
   */
  windowCapTracks: number;
}

/**
 * Creation-time headroom gate: Start Session / More Like
 * This are refused unless the remaining headroom (in TRACKS) is at least
 * `minHeadroomTracks`, so a freshly-created session is guaranteed enough of its
 * own material to fall back on (Session Repeat) rather than stranding the user at
 * an empty buffer. Headroom is the TIGHTEST bound's, and the reported scope is
 * that bound — the earlier one on ties, matching admission precedence. The
 * threshold is always the instance value; it is not a per-Member knob. Pure: the
 * caller passes the already-counted task usage. A `minHeadroomTracks` of 0
 * disables the gate. Resume is NEVER routed through this gate.
 */
export function evaluateCreationHeadroom(
  bounds: CostBounds,
  tracksPerCall: number,
  minHeadroomTracks: number,
): CreationHeadroomDecision {
  const { bound, remainingTracks } = tightestBound(bounds, tracksPerCall);
  const binding = tightestWindow(bound.windows);
  const allowed = remainingTracks >= minHeadroomTracks;
  const resetWindow =
    !allowed && binding.window === 'day'
      ? (windowRefusingAfterMidnight(bounds, tracksPerCall, minHeadroomTracks) ?? 'day')
      : binding.window;
  return {
    allowed,
    remainingTracks,
    minHeadroomTracks,
    scope: bound.scope,
    window: binding.window,
    resetWindow,
    windowCapTracks: binding.cap * tracksPerCall,
  };
}

/**
 * The bound with the least headroom, in tracks. Strictly tighter wins, so ties
 * keep the earlier bound — the same precedence `checkCostLimits` refuses in.
 */
function tightestBound(
  bounds: CostBounds,
  tracksPerCall: number,
): { bound: CostBound; remainingTracks: number } {
  let bound = bounds[0];
  let remainingTracks = remainingHeadroomTracks(bound.windows, tracksPerCall);
  for (const candidate of bounds) {
    const remaining = remainingHeadroomTracks(candidate.windows, tracksPerCall);
    if (remaining < remainingTracks) {
      bound = candidate;
      remainingTracks = remaining;
    }
  }
  return { bound, remainingTracks };
}

/** The month or total window that still holds a Session back once every day
 *  window resets, or null when midnight is enough. */
function windowRefusingAfterMidnight(
  bounds: CostBounds,
  tracksPerCall: number,
  minHeadroomTracks: number,
): CostLimitWindow | null {
  const afterMidnight = mapNonEmpty(bounds, (bound) => ({
    ...bound,
    windows: mapNonEmpty(bound.windows, (window) =>
      window.window === 'day' ? { ...window, used: 0 } : window,
    ),
  }));
  const { bound, remainingTracks } = tightestBound(afterMidnight, tracksPerCall);
  if (remainingTracks >= minHeadroomTracks) return null;
  const { window } = tightestWindow(bound.windows);
  return window === 'day' ? null : window;
}

function mapNonEmpty<T, U>(items: readonly [T, ...T[]], fn: (item: T) => U): [U, ...U[]] {
  const [first, ...rest] = items;
  return [fn(first), ...rest.map(fn)];
}
