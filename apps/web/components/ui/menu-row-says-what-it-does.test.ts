// @vitest-environment jsdom

// A phone has no hover, so what an option does has to be on the row itself.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MenuRow } from './menu-row';

afterEach(cleanup);

describe('a menu row', () => {
  it('shows its description beside the live note', () => {
    render(
      h(MenuRow, {
        icon: null,
        label: 'Sleep Timer',
        description: 'Fade out and pause the music after a set time',
        note: '5 min left',
      }),
    );

    const row = screen.getByRole('button');
    expect(row.textContent).toContain('Fade out and pause the music after a set time');
    expect(row.textContent).toContain('5 min left');
  });
});
