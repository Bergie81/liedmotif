// @vitest-environment jsdom

// The grabber bar atop every bottom sheet: dragging it down far enough closes
// the sheet through the same path as its close button, so a sheet that locks
// its close button while busy also refuses the drag.

import { createElement as h } from 'react';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Sheet, SheetContent, SheetHeader } from './sheet';

beforeAll(() => {
  // jsdom implements no pointer capture.
  HTMLElement.prototype.setPointerCapture = () => {};
});

afterEach(cleanup);

function renderSheet(closeDisabled = false) {
  const onOpenChange = vi.fn();
  render(
    h(
      Sheet,
      { open: true, onOpenChange },
      h(SheetContent, { side: 'bottom' }, h(SheetHeader, { title: 'Options', closeDisabled })),
    ),
  );
  return onOpenChange;
}

// Each sample carries a fixed timestamp: a real clock can tick 1ms between
// samples, which turns any short drag into a flick. React reads a 0 timestamp
// as missing and substitutes Date.now(), so samples start above 0.
function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', clientY: number, time: number) {
  const grabber = screen.getByTestId('sheet-grabber');
  const event = createEvent[type](grabber, { pointerId: 1, button: 0, clientY });
  Object.defineProperty(event, 'timeStamp', { value: time });
  fireEvent(grabber, event);
}

/** A slow drag, well below flick speed. */
function drag(distance: number) {
  pointer('pointerDown', 100, 1000);
  pointer('pointerMove', 100 + distance, 2000);
  pointer('pointerUp', 100 + distance, 2000);
}

describe('sheet grabber', () => {
  it('closes the sheet when dragged down far enough', () => {
    const onOpenChange = renderSheet();
    drag(160);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('springs back and stays open after a short drag', () => {
    const onOpenChange = renderSheet();
    drag(30);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').style.transform).toBe('');
  });

  it('does not close a sheet whose close button is locked', () => {
    const onOpenChange = renderSheet(true);
    drag(160);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
