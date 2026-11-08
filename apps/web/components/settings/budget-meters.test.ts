import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BudgetUsageMeters } from './budget-meters';

const costs = { perTrackUsd: 0.07, perCoverUsd: 0.04 };
const usage = {
  kind: 'oneTime' as const,
  tracks: { used: 8, limit: 40, remaining: 32 },
  covers: { used: 3, limit: 20, remaining: 17 },
};
const text = (props: Parameters<typeof BudgetUsageMeters>[0]) =>
  renderToStaticMarkup(createElement(BudgetUsageMeters, props)).replace(/<[^>]*>/g, '');

describe('budget meters', () => {
  it('prices remaining one-time budgets first on the admin Members page only', () => {
    const admin = text({ usage, unitCosts: costs });
    expect(admin).toContain('$2.24/$2.80 (32/40 Tracks) left');
    expect(admin).toContain('$0.68/$0.80 (17/20 Covers) left');
    const member = text({ usage });
    expect(member).toContain('32/40 Tracks left');
    expect(member).not.toContain('$');
  });
});
