import { describe, expect, it } from 'vitest';
import {
  checkCostLimits,
  evaluateCreationHeadroom,
  memberBoundScope,
  oneTimeBudgetUsedUpMessage,
  remainingHeadroomTracks,
  type BoundWindows,
  type CostBound,
} from './limits';

// Spend is counted internally in provider calls (tasks); every user-facing number
// is in tracks. A cost-limit failure is what degrades a running
// session to Session Repeat. A submit is held to an ordered list of
// bounds — one for the Admin, two for a Member — and list order is the
// refusal precedence.
const LIMITS = { dailyGenerationTasks: 40, monthlyGenerationTasks: 400 };

interface RollingInput {
  dailyGenerationTasks: number;
  monthlyGenerationTasks: number;
  dailyTasksUsed: number;
  monthlyTasksUsed: number;
}

/** A rolling budget as the bound model takes it: `[day, month]`. */
const rolling = (input: RollingInput): BoundWindows => [
  { window: 'day', cap: input.dailyGenerationTasks, used: input.dailyTasksUsed },
  { window: 'month', cap: input.monthlyGenerationTasks, used: input.monthlyTasksUsed },
];

const instance = (input: Omit<RollingInput, keyof typeof LIMITS>): CostBound => ({
  scope: 'instance',
  windows: rolling({ ...LIMITS, ...input }),
});

describe('checkCostLimits', () => {
  it('allows a submit while both windows have headroom', () => {
    const result = checkCostLimits([instance({ dailyTasksUsed: 10, monthlyTasksUsed: 100 })]);
    expect(result.withinLimits).toBe(true);
  });

  it('blocks on the daily window when the day cap is reached', () => {
    const result = checkCostLimits([instance({ dailyTasksUsed: 40, monthlyTasksUsed: 100 })]);
    expect(result).toEqual({ withinLimits: false, window: 'day', scope: 'instance' });
  });

  it('blocks on the monthly window when only the month cap is reached', () => {
    const result = checkCostLimits([instance({ dailyTasksUsed: 10, monthlyTasksUsed: 400 })]);
    expect(result).toEqual({ withinLimits: false, window: 'month', scope: 'instance' });
  });

  it('reports the daily window first when both caps are reached', () => {
    const result = checkCostLimits([instance({ dailyTasksUsed: 40, monthlyTasksUsed: 400 })]);
    expect(result).toEqual({ withinLimits: false, window: 'day', scope: 'instance' });
  });
});

// A Member is held to their own budget AND the Members Pool. The
// personal bound is listed first, so when both bind the refusal names the budget
// the Member themselves spent rather than one they cannot influence.
describe('checkCostLimits — the Member two-bound list', () => {
  const open: RollingInput = {
    dailyGenerationTasks: 10,
    monthlyGenerationTasks: 50,
    dailyTasksUsed: 0,
    monthlyTasksUsed: 0,
  };
  const spent: RollingInput = { ...open, dailyTasksUsed: 10 };
  const bounds = (member: RollingInput, pool: RollingInput) =>
    [
      { scope: 'member', windows: rolling(member) },
      { scope: 'pool', windows: rolling(pool) },
    ] as const;

  it('admits when both bounds have headroom', () => {
    expect(checkCostLimits(bounds(open, open))).toEqual({ withinLimits: true });
  });

  it('names the member scope when the personal budget binds', () => {
    expect(checkCostLimits(bounds(spent, open))).toEqual({
      withinLimits: false,
      window: 'day',
      scope: 'member',
    });
  });

  it('names the pool scope when only the shared budget binds', () => {
    expect(checkCostLimits(bounds(open, spent))).toEqual({
      withinLimits: false,
      window: 'day',
      scope: 'pool',
    });
  });

  it('reports the member scope when BOTH bind (list order is precedence)', () => {
    expect(checkCostLimits(bounds(spent, spent))).toEqual({
      withinLimits: false,
      window: 'day',
      scope: 'member',
    });
  });
});

describe('memberBoundScope', () => {
  it('is null for the Admin bound — the session row records no Member scope', () => {
    expect(memberBoundScope('instance')).toBeNull();
  });

  it('passes a Member bound through unchanged', () => {
    expect(memberBoundScope('member')).toBe('member');
    expect(memberBoundScope('pool')).toBe('pool');
  });
});

describe('remainingHeadroomTracks', () => {
  it('is the tighter window converted to tracks (tasks × tracks-per-call)', () => {
    // daily headroom 30 tasks, monthly headroom 20 tasks → 20 tasks bind → 40 tracks.
    expect(
      remainingHeadroomTracks(rolling({ ...LIMITS, dailyTasksUsed: 10, monthlyTasksUsed: 380 }), 2),
    ).toBe(40);
  });

  it('never goes negative when a window is already over its cap', () => {
    expect(
      remainingHeadroomTracks(rolling({ ...LIMITS, dailyTasksUsed: 41, monthlyTasksUsed: 0 }), 2),
    ).toBe(0);
  });
});

// The creation-time headroom gate: Start Session / More Like This are
// refused unless at least `minHeadroomTracks` of remaining headroom exist, so a
// fresh session is guaranteed enough of its own material to fall back on. The unit
// of the threshold is TRACKS (Suno yields 2/call) even though spend is counted in
// tasks. Resume is NEVER routed through this gate (it is checked at the route).
describe('evaluateCreationHeadroom', () => {
  it('allows creation when remaining headroom meets the threshold', () => {
    // daily 30 tasks left, monthly 20 tasks left → 20 bind → 40 tracks ≥ 5.
    const decision = evaluateCreationHeadroom(
      [instance({ dailyTasksUsed: 10, monthlyTasksUsed: 380 })],
      2,
      5,
    );
    expect(decision).toEqual({
      allowed: true,
      remainingTracks: 40,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'month',
      resetWindow: 'month',
      windowCapTracks: 800,
    });
  });

  it('allows creation when remaining headroom exactly equals the threshold', () => {
    // 1 task left in the tighter window → 2 tracks; min 2 → allowed (>=).
    const decision = evaluateCreationHeadroom(
      [instance({ dailyTasksUsed: 39, monthlyTasksUsed: 0 })],
      2,
      2,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.remainingTracks).toBe(2);
  });

  it('blocks creation when remaining headroom is below the threshold', () => {
    // 1 task left → 2 tracks; min 5 → blocked, NO session may be created.
    const decision = evaluateCreationHeadroom(
      [instance({ dailyTasksUsed: 39, monthlyTasksUsed: 0 })],
      2,
      5,
    );
    expect(decision).toEqual({
      allowed: false,
      remainingTracks: 2,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'day',
      resetWindow: 'day',
      windowCapTracks: 80,
    });
  });

  it('blocks creation when a window is already exhausted (0 remaining)', () => {
    const decision = evaluateCreationHeadroom(
      [instance({ dailyTasksUsed: 40, monthlyTasksUsed: 0 })],
      2,
      5,
    );
    expect(decision).toEqual({
      allowed: false,
      remainingTracks: 0,
      minHeadroomTracks: 5,
      scope: 'instance',
      window: 'day',
      resetWindow: 'day',
      windowCapTracks: 80,
    });
  });

  it('names the tighter window, the day on ties, so refusal copy can say when it rolls over', () => {
    expect(
      evaluateCreationHeadroom([instance({ dailyTasksUsed: 39, monthlyTasksUsed: 399 })], 2, 5)
        .window,
    ).toBe('day');
    expect(
      evaluateCreationHeadroom([instance({ dailyTasksUsed: 0, monthlyTasksUsed: 399 })], 2, 5)
        .window,
    ).toBe('month');
  });

  it("carries the binding window's own cap in tracks, so copy can tell when waiting cannot help", () => {
    // Daily cap 2 tasks (4 tracks) below a 5-track threshold: no reset fixes that.
    const decision = evaluateCreationHeadroom(
      [
        {
          scope: 'instance',
          windows: rolling({
            ...LIMITS,
            dailyGenerationTasks: 2,
            dailyTasksUsed: 0,
            monthlyTasksUsed: 0,
          }),
        },
      ],
      2,
      5,
    );
    expect(decision).toMatchObject({ allowed: false, window: 'day', windowCapTracks: 4 });
    expect(
      evaluateCreationHeadroom([instance({ dailyTasksUsed: 0, monthlyTasksUsed: 399 })], 2, 5)
        .windowCapTracks,
    ).toBe(800);
  });

  it('names the month reset when the month still refuses once the day resets', () => {
    // Day used up (0 left), month 2 tasks left → 4 tracks: midnight brings back
    // only what the month still has, so the Session waits for the 1st.
    const decision = evaluateCreationHeadroom(
      [instance({ dailyTasksUsed: 40, monthlyTasksUsed: 398 })],
      2,
      5,
    );
    expect(decision).toMatchObject({ allowed: false, window: 'day', resetWindow: 'month' });
    // A month with room left: the day reset is the one that helps.
    expect(
      evaluateCreationHeadroom([instance({ dailyTasksUsed: 40, monthlyTasksUsed: 0 })], 2, 5),
    ).toMatchObject({ allowed: false, window: 'day', resetWindow: 'day' });
  });

  it('names the month reset when another bound’s month still refuses after midnight', () => {
    const decision = evaluateCreationHeadroom(
      [
        {
          scope: 'member',
          windows: rolling({ ...LIMITS, dailyTasksUsed: 40, monthlyTasksUsed: 0 }),
        },
        {
          scope: 'pool',
          windows: rolling({ ...LIMITS, dailyTasksUsed: 0, monthlyTasksUsed: 399 }),
        },
      ],
      2,
      5,
    );
    expect(decision).toMatchObject({
      allowed: false,
      scope: 'member',
      window: 'day',
      resetWindow: 'month',
    });
  });

  it('treats a zero threshold as the gate being disabled (always allowed)', () => {
    const decision = evaluateCreationHeadroom(
      [instance({ dailyTasksUsed: 40, monthlyTasksUsed: 400 })],
      2,
      0,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.remainingTracks).toBe(0);
  });
});

describe('evaluateCreationHeadroom — the Member two-bound list', () => {
  const window = (cap: number, used = 0): BoundWindows =>
    rolling({
      dailyGenerationTasks: cap,
      monthlyGenerationTasks: cap * 10,
      dailyTasksUsed: used,
      monthlyTasksUsed: used,
    });
  const bounds = (memberCap: number, poolCap: number) =>
    [
      { scope: 'member', windows: window(memberCap) },
      { scope: 'pool', windows: window(poolCap) },
    ] as const;

  it('takes the tighter of the two bounds, in tracks', () => {
    const decision = evaluateCreationHeadroom(bounds(10, 3), 2, 5);
    expect(decision).toEqual({
      allowed: true,
      remainingTracks: 6,
      minHeadroomTracks: 5,
      scope: 'pool',
      window: 'day',
      resetWindow: 'day',
      windowCapTracks: 6,
    });
  });

  it('reports the member scope on ties (matching admission precedence)', () => {
    const decision = evaluateCreationHeadroom(bounds(5, 5), 2, 20);
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe('member');
  });
});

// A One-time Member budget is ONE window: everything spent
// since its Grant against a total that never renews. It refuses with its own
// window name so the copy can say "ask the Admin" instead of "wait".
describe('One-time bounds', () => {
  const oneTime = (total: number, used: number): CostBound => ({
    scope: 'member',
    windows: [{ window: 'total', cap: total, used }],
  });
  const pool: RollingInput = {
    dailyGenerationTasks: 40,
    monthlyGenerationTasks: 200,
    dailyTasksUsed: 0,
    monthlyTasksUsed: 0,
  };
  const openPool: CostBound = { scope: 'pool', windows: rolling(pool) };

  it('admits while the total has headroom', () => {
    expect(checkCostLimits([oneTime(13, 12), openPool]).withinLimits).toBe(true);
  });

  it('refuses on the total window once used reaches the total', () => {
    expect(checkCostLimits([oneTime(13, 13), openPool])).toEqual({
      withinLimits: false,
      window: 'total',
      scope: 'member',
    });
  });

  it('is refused by the pool when only the pool binds', () => {
    const spentPool: CostBound = {
      scope: 'pool',
      windows: rolling({ ...pool, dailyTasksUsed: 40 }),
    };
    expect(checkCostLimits([oneTime(13, 0), spentPool])).toEqual({
      withinLimits: false,
      window: 'day',
      scope: 'pool',
    });
  });

  it('measures headroom as total − used, in tracks, never negative', () => {
    expect(remainingHeadroomTracks(oneTime(13, 10).windows, 2)).toBe(6);
    expect(remainingHeadroomTracks(oneTime(13, 20).windows, 2)).toBe(0);
  });

  it('gates session creation on the remaining total', () => {
    expect(evaluateCreationHeadroom([oneTime(13, 11), openPool], 2, 5)).toEqual({
      allowed: false,
      remainingTracks: 4,
      minHeadroomTracks: 5,
      scope: 'member',
      window: 'total',
      resetWindow: 'total',
      windowCapTracks: 26,
    });
    expect(evaluateCreationHeadroom([oneTime(13, 10), openPool], 2, 5).allowed).toBe(true);
  });

  it('names the Admin — never a rollover — in the used-up copy', () => {
    expect(oneTimeBudgetUsedUpMessage('John')).toBe('Your budget is used up. Ask John for more.');
    expect(oneTimeBudgetUsedUpMessage(null)).toBe(
      'Your budget is used up. Ask the Admin for more.',
    );
  });
});
