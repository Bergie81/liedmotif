// @vitest-environment jsdom

// An options sheet opened offline shows fewer or darker rows; its header says
// why. The mark is a button left of the close button that opens a short
// explanation, present only while offline and only on the sheets that ask for it.

import { act, createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sheet, SheetContent, SheetHeader } from './sheet';

let browserOnline = true;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });

function setBrowserOnline(online: boolean) {
  browserOnline = online;
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  setBrowserOnline(true);
  cleanup();
});

function renderSheet(offlineMark: boolean) {
  render(
    h(
      Sheet,
      { open: true },
      h(SheetContent, { side: 'bottom' }, h(SheetHeader, { title: 'Options', offlineMark })),
    ),
  );
}

const queryMark = () => screen.queryByRole('button', { name: /offline/i });

describe('options sheet header offline mark', () => {
  it('stays away while online', () => {
    renderSheet(true);
    expect(queryMark()).toBeNull();
  });

  it('appears offline before the close button and explains itself when tapped', () => {
    renderSheet(true);
    setBrowserOnline(false);

    const mark = queryMark();
    expect(mark).not.toBeNull();
    const close = screen.getByRole('button', { name: 'Close Options' });
    expect(mark!.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(mark!);
    expect(screen.getByText(/only music kept on this device plays/i)).not.toBeNull();

    setBrowserOnline(true);
    expect(queryMark()).toBeNull();
  });

  it('is absent from a sheet that does not ask for it', () => {
    renderSheet(false);
    setBrowserOnline(false);
    expect(queryMark()).toBeNull();
  });
});
