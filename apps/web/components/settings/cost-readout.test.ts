import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricedQuantity } from './cost-readout';

const costs = { perTrackUsd: 0.07, perCoverUsd: 0.04 };
const text = (props: Parameters<typeof PricedQuantity>[0]) =>
  renderToStaticMarkup(createElement(PricedQuantity, props)).replace(/<[^>]*>/g, '');

describe('settings cost readouts', () => {
  it('leads member budgets with dollars and brackets the corresponding Covers', () => {
    expect(text({ quantity: 3, limit: 20, unit: 'Covers', costs, costFirst: true })).toBe(
      '$0.12/$0.80 (3/20 Covers)',
    );
    expect(text({ quantity: 26, unit: 'Tracks', costs, costFirst: true })).toBe(
      '$1.82 (26 Tracks)',
    );
  });

  it('hides estimates without configured prices and preserves a zero-priced unit', () => {
    expect(text({ quantity: 8, limit: 40, unit: 'Tracks', costFirst: true })).toBe('8/40 Tracks');
    expect(text({ quantity: 8, unit: 'Tracks', costs: { perTrackUsd: 0, perCoverUsd: 0 } })).toBe(
      '8 Tracks',
    );
    expect(
      text({
        quantity: 3,
        unit: 'Covers',
        costs: { perTrackUsd: 0.07, perCoverUsd: 0 },
        costFirst: true,
      }),
    ).toBe('$0 (3 Covers)');
  });

  it('shows usage in Tracks with both dollar amounts in brackets', () => {
    expect(text({ quantity: 8, limit: 40, unit: 'Tracks', costs })).toBe(
      '8/40 Tracks ($0.56/$2.80)',
    );
  });
});
