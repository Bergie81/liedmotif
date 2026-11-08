// @vitest-environment jsdom

// The period picker sits above both of the Admin's tabs, so it reads as one
// period for the whole page: choosing one must reach both tabs' figures, and
// switching tab must not change what the picker shows.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CostComparisonData, ListeningStatsData } from '@liedmotif/shared';
import { fetchCostComparison, fetchListeningStats } from '@/lib/api-client';
import { StatsTabs } from './stats-tabs';

vi.mock('@/lib/api-client', () => ({
  fetchListeningStats: vi.fn(async (range: string) => ({
    ok: true,
    data: { range, from: null, timezone: 'UTC' },
  })),
  fetchCostComparison: vi.fn(async (range: string) => ({
    ok: true,
    data: { range, from: null, timezone: 'UTC' },
  })),
}));
vi.mock('./your-stats', () => ({ YourStats: () => null }));
vi.mock('./costs', () => ({ Costs: () => null }));

const period = { range: '30d', from: null, timezone: 'UTC' };
const listening = period as unknown as ListeningStatsData;
const costs = period as unknown as CostComparisonData;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StatsTabs for the Admin', () => {
  it('applies a chosen period to both tabs and keeps it across a tab switch', async () => {
    render(h(StatsTabs, { listening, costs }));

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() => expect(fetchListeningStats).toHaveBeenCalledWith('7d'));
    expect(fetchCostComparison).toHaveBeenCalledWith('7d');

    // Radix selects a tab on mouse down, not on click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Costs' }), { button: 0 });

    expect(screen.getByRole('tab', { name: 'Costs' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
