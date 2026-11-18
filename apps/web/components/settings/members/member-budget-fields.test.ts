import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemberBudgetKindFields } from './member-budget-fields';

const props = {
  values: {
    dailyTracks: '20',
    monthlyTracks: '100',
    coversPerDay: '10',
    coversPerMonth: '60',
    totalTracks: '25',
    totalCovers: '40',
  },
  errors: {},
  disabled: false,
  tracksPerCall: 2,
  minHeadroomTracks: 5,
  onChange: () => {},
  onKindChange: () => {},
  unitCosts: { perTrackUsd: 0.07, perCoverUsd: 0.04 },
};
const text = (kind: 'oneTime' | 'rolling', values: Partial<typeof props.values> = {}) =>
  renderToStaticMarkup(
    createElement(MemberBudgetKindFields, {
      ...props,
      values: { ...props.values, ...values },
      kind,
    }),
  ).replace(/<[^>]*>/g, '');

const START_WARNING = 'Below 5 Tracks, no new Session can start.';

describe('member budget setup', () => {
  it('prices all four rolling windows with their own Track or Cover unit cost', () => {
    const rolling = text('rolling');
    expect(rolling).toContain('$1.40 (20 Tracks)');
    expect(rolling).toContain('$7.00 (100 Tracks)');
    expect(rolling).toContain('$0.40 (10 Covers)');
    expect(rolling).toContain('$2.40 (60 Covers)');
  });

  it('shows dollar-first estimates for each total using the count saved after batch rounding', () => {
    const oneTime = text('oneTime');
    expect(oneTime).toContain('$1.82 (26 Tracks)');
    expect(oneTime).toContain('$1.60 (40 Covers)');
  });
});

describe('budget below the Session-start headroom', () => {
  it('warns beside a Track window no new Session could start under', () => {
    expect(text('rolling', { dailyTracks: '4' })).toContain(START_WARNING);
    expect(text('rolling')).not.toContain(START_WARNING);
  });

  it('warns beside a One-time Tracks total no new Session could start under', () => {
    expect(text('oneTime', { totalTracks: '4' })).toContain(START_WARNING);
    expect(text('oneTime')).not.toContain(START_WARNING);
  });

  it('never warns on Cover fields', () => {
    expect(text('rolling', { coversPerDay: '1', coversPerMonth: '1' })).not.toContain(
      START_WARNING,
    );
  });
});
