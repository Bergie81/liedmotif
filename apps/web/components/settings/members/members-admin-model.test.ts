import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMBER_LIMITS } from '@liedmotif/shared';
import {
  buildMemberBudgetKindPatch,
  buildMemberBudgetPatch,
  formatInviteExpiry,
  formatShortDate,
  formEstimateCounts,
  membersCostSummary,
  memberBudgetFieldMax,
  memberBudgetFormValues,
  memberBudgetWarnings,
  memberMetaLine,
  newInviteTotals,
  overSubscriptionMessage,
  resetFallbackLine,
} from './members-admin-model';

describe('member budget form', () => {
  it('round-trips the stored task budget through display Tracks', () => {
    const values = memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2);
    // Defaults: 10/50 tasks → 20/100 Tracks at 2 per call; covers pass through;
    // stored One-time totals (25 tasks / 25 covers) show as the Tracks they buy.
    expect(values).toEqual({
      dailyTracks: '20',
      monthlyTracks: '100',
      coversPerDay: '10',
      coversPerMonth: '25',
      totalTracks: '50',
      totalCovers: '25',
    });

    const patch = buildMemberBudgetPatch(values, 2);
    expect(patch).toEqual({
      ok: true,
      patch: {
        dailyGenerationTasks: 10,
        monthlyGenerationTasks: 50,
        generatedCoversPerDay: 10,
        generatedCoversPerMonth: 25,
      },
    });
  });

  it("builds only the chosen kind's fields, so the route never sees the other kind's", () => {
    const values = memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2);
    expect(buildMemberBudgetKindPatch('rolling', values, 2)).toEqual({
      ok: true,
      patch: {
        kind: 'rolling',
        dailyGenerationTasks: 10,
        monthlyGenerationTasks: 50,
        generatedCoversPerDay: 10,
        generatedCoversPerMonth: 25,
      },
    });
    expect(buildMemberBudgetKindPatch('oneTime', values, 2)).toEqual({
      ok: true,
      patch: { kind: 'oneTime', totalGenerationTasks: 25, totalGeneratedCovers: 25 },
    });
  });

  it('seeds a new invite with totals its own readout leaves untouched', () => {
    // A typed total is "at least this many", rounded up to whole calls. A seed
    // below a call boundary would show one figure in the field and another in
    // the readout under it.
    const values = { ...memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2), ...newInviteTotals(2) };
    expect(values).toMatchObject({ totalTracks: '50', totalCovers: '25' });
    expect(formEstimateCounts('oneTime', values, 2)).toEqual({ tracks: 50, covers: 25 });
    expect(buildMemberBudgetKindPatch('oneTime', values, 2)).toEqual({
      ok: true,
      patch: { kind: 'oneTime', totalGenerationTasks: 25, totalGeneratedCovers: 25 },
    });
  });

  it('names a typed One-time total that is blank, not a whole number, or above the ceiling', () => {
    const values = memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2);
    const bad = buildMemberBudgetKindPatch(
      'oneTime',
      { ...values, totalTracks: '', totalCovers: '-1' },
      2,
    );
    expect(bad).toEqual({
      ok: false,
      errors: {
        totalTracks: 'Enter a whole number (0 or more).',
        totalCovers: 'Enter a whole number (0 or more).',
      },
    });
    const high = buildMemberBudgetKindPatch(
      'oneTime',
      { ...values, totalTracks: String(memberBudgetFieldMax('totalTracks', 2) + 1) },
      2,
    );
    expect(high).toMatchObject({ ok: false, errors: { totalTracks: expect.any(String) } });
  });

  it('refuses Tracks that do not divide into whole provider calls', () => {
    const result = buildMemberBudgetPatch(
      { ...memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2), dailyTracks: '21' },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.dailyTracks).toContain('multiple of 2');
  });

  it('refuses a budget above the shared ceiling, in the unit the row shows', () => {
    // The schema refuses the same value in tasks; the admin edits Tracks, so the
    // form must name the ceiling they can act on rather than post and fail.
    const result = buildMemberBudgetPatch(
      {
        ...memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2),
        dailyTracks: String(memberBudgetFieldMax('dailyTracks', 2) + 2),
        coversPerDay: String(memberBudgetFieldMax('coversPerDay', 2) + 1),
      },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      dailyTracks: 'Enter at most 2000 tracks.',
      coversPerDay: 'Enter at most 1000 covers.',
    });
  });

  it('refuses a monthly cap below the daily one, as the budget routes do', () => {
    const result = buildMemberBudgetPatch(
      {
        ...memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2),
        dailyTracks: '20',
        monthlyTracks: '10',
        coversPerDay: '10',
        coversPerMonth: '9',
      },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      monthlyTracks: 'Enter 20 or more.',
      coversPerMonth: 'Enter 10 or more.',
    });
  });

  it('refuses non-numbers with a per-field message', () => {
    const result = buildMemberBudgetPatch(
      {
        ...memberBudgetFormValues(DEFAULT_MEMBER_LIMITS, 2),
        monthlyTracks: '-3',
        coversPerDay: 'x',
      },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['coversPerDay', 'monthlyTracks']);
  });
});

describe('member meta line', () => {
  it('reads joined, sign-in activity, tracks, and bytes in one line', () => {
    expect(
      memberMetaLine(
        {
          joinedAt: '2026-07-12T08:00:00.000Z',
          lastActiveAt: '2026-07-29T21:30:00.000Z',
          trackCount: 1,
          storageBytes: 3 * 1024 ** 2,
        },
        'UTC',
      ),
    ).toBe('Joined Jul 12, 2026 · Sign-in active Jul 29, 2026 · 1 track · 3.0 MiB');
  });

  it('says a Member without a current sign-in has none, without claiming they never signed in', () => {
    const line = memberMetaLine(
      {
        joinedAt: '2026-07-12T08:00:00.000Z',
        lastActiveAt: null,
        trackCount: 0,
        storageBytes: 0,
      },
      'UTC',
    );

    expect(line).toBe('Joined Jul 12, 2026 · No active sign-in · 0 tracks · 0 B');
    expect(line).not.toContain('Never');
  });

  it('formatShortDate answers a dash for garbage', () => {
    expect(formatShortDate('not-a-date', 'UTC')).toBe('—');
  });

  it('formatShortDate shows the day in the Instance timezone, not the UTC day', () => {
    // 00:30 on 4 November in Berlin is still 3 November in UTC.
    expect(formatShortDate('2026-11-03T23:30:00.000Z', 'Europe/Berlin')).toBe('Nov 4, 2026');
  });

  it('dates Joined and sign-in activity in the Instance timezone', () => {
    expect(
      memberMetaLine(
        {
          joinedAt: '2026-11-03T23:30:00.000Z',
          lastActiveAt: '2026-11-04T23:15:00.000Z',
          trackCount: 2,
          storageBytes: 0,
        },
        'Europe/Berlin',
      ),
    ).toMatch(/^Joined Nov 4, 2026 · Sign-in active Nov 5, 2026 · /);
  });

  it("states an Invite's exact expiry with the day, time and timezone it is in", () => {
    expect(formatInviteExpiry('2026-11-03T23:30:00.000Z', 'Europe/Berlin')).toBe(
      'Nov 4, 2026, 00:30 Europe/Berlin',
    );
  });
});

describe('over-subscription copy', () => {
  it('converts task fields to Tracks and passes cover fields through', () => {
    expect(
      overSubscriptionMessage({ field: 'dailyGenerationTasks', membersTotal: 60, poolCap: 40 }, 2),
    ).toBe(
      "Members' daily track budgets add up to 120 tracks; the shared pool allows 80. That is fine — the pool is first come, first served.",
    );
    expect(
      overSubscriptionMessage(
        { field: 'generatedCoversPerMonth', membersTotal: 240, poolCap: 200 },
        2,
      ),
    ).toContain('240 covers; the shared pool allows 200');
  });
});

describe('Member reset fallback line', () => {
  it('says why a reset was not mailed, and adds nothing while account email is off', () => {
    expect(resetFallbackLine('email_off')).toBeNull();
    expect(resetFallbackLine('unconfirmed')).toBe(
      "This member hasn't confirmed their email, so copy the link and send it yourself.",
    );
    expect(resetFallbackLine('disabled')).toMatch(/disabled/);
    expect(resetFallbackLine('send_failed')).toMatch(/could not be sent/);
  });
});

describe('estimated cost readouts', () => {
  const costs = { perTrackUsd: 0.1, perCoverUsd: 0.05 };
  const values = {
    dailyTracks: '20',
    monthlyTracks: '100',
    coversPerDay: '10',
    coversPerMonth: '60',
    totalTracks: '25',
    totalCovers: '40',
  };

  it("prices the form's totals for One-time and its monthly caps for Rolling", () => {
    // 25 typed Tracks are stored as 13 calls = 26 Tracks; the estimate prices what is saved.
    expect(formEstimateCounts('oneTime', values, 2)).toEqual({ tracks: 26, covers: 40 });
    expect(formEstimateCounts('rolling', values, 2)).toEqual({ tracks: 100, covers: 60 });
    expect(formEstimateCounts('oneTime', { ...values, totalTracks: 'x' }, 2)).toBeNull();
  });

  it.each(['', '-1', '1.5', '100000000'])(
    'omits estimates for a total that cannot be saved: %s',
    (raw) => {
      expect(formEstimateCounts('oneTime', { ...values, totalTracks: raw }, 2)).toBeNull();
      expect(formEstimateCounts('oneTime', { ...values, totalCovers: raw }, 2)).toBeNull();
    },
  );

  const rolling = {
    kind: 'rolling' as const,
    figures: {
      tracksDay: { used: 2, limit: 20, remaining: 18 },
      tracksMonth: { used: 30, limit: 100, remaining: 70 },
      coversDay: { used: 1, limit: 10, remaining: 9 },
      coversMonth: { used: 20, limit: 60, remaining: 40 },
    },
  };
  const oneTime = {
    kind: 'oneTime' as const,
    tracks: { used: 10, limit: 25, remaining: 15 },
    covers: { used: 4, limit: 40, remaining: 36 },
  };

  it('sums claimed Members per kind, Disabled included, and folds Tracks and Covers into one figure', () => {
    const summary = membersCostSummary(
      [{ usage: rolling }, { usage: rolling }, { usage: oneTime }],
      costs,
    );
    expect(summary).toEqual({
      rolling: { maxPerMonth: 26, usedThisMonth: 8 },
      oneTime: { outstanding: 3.3, used: 1.2 },
    });
  });

  it('drops the line of a kind no Member holds, and the summary when there is no Member', () => {
    expect(membersCostSummary([{ usage: rolling }], costs)).toEqual({
      rolling: { maxPerMonth: 13, usedThisMonth: 4 },
      oneTime: null,
    });
    expect(membersCostSummary([{ usage: oneTime }], costs)).toEqual({
      rolling: null,
      oneTime: { outstanding: 3.3, used: 1.2 },
    });
    expect(membersCostSummary([], costs)).toBeNull();
  });

  it('has no summary while both prices are 0', () => {
    const zeroed = { perTrackUsd: 0, perCoverUsd: 0 };
    expect(membersCostSummary([{ usage: rolling }], zeroed)).toBeNull();
  });
});

describe('budgets below the Session-start headroom', () => {
  const values = {
    dailyTracks: '20',
    monthlyTracks: '100',
    coversPerDay: '1',
    coversPerMonth: '2',
    totalTracks: '50',
    totalCovers: '1',
  };
  const warning = 'Below 5 tracks, no new session can start.';

  it('warns on 4 Tracks a day with headroom 5, and the budget still saves', () => {
    const low = { ...values, dailyTracks: '4' };
    expect(memberBudgetWarnings(low, 2, 5)).toEqual({ dailyTracks: warning });
    expect(buildMemberBudgetPatch(low, 2)).toMatchObject({
      ok: true,
      patch: { dailyGenerationTasks: 2 },
    });
  });

  it('warns on the month window and on a One-time total as it will be stored', () => {
    // A typed 3 is stored as 4 (whole calls), still short of 5; a typed 5 becomes 6.
    expect(memberBudgetWarnings({ ...values, monthlyTracks: '2', totalTracks: '3' }, 2, 5)).toEqual(
      { monthlyTracks: warning, totalTracks: warning },
    );
    expect(memberBudgetWarnings({ ...values, totalTracks: '5' }, 2, 5)).toEqual({});
  });

  it('leaves Covers, a deliberate 0, and a headroom of 0 without a warning', () => {
    expect(memberBudgetWarnings(values, 2, 5)).toEqual({});
    expect(memberBudgetWarnings({ ...values, dailyTracks: '0' }, 2, 5)).toEqual({});
    expect(memberBudgetWarnings({ ...values, dailyTracks: '2' }, 2, 0)).toEqual({});
  });

  it('keeps the existing refusals: whole calls, and the month not below the day', () => {
    expect(buildMemberBudgetPatch({ ...values, dailyTracks: '4', monthlyTracks: '2' }, 2)).toEqual({
      ok: false,
      errors: { monthlyTracks: 'Enter 4 or more.' },
    });
  });
});
