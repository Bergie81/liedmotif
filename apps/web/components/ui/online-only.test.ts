// @vitest-environment jsdom

// The one way an act that needs the server goes quiet offline: disabled in
// place, saying "Offline", and back on its own when the connection returns.

import { act, createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MenuRow } from './menu-row';
import { OnlineOnly } from './online-only';

let browserOnline = true;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });

function setBrowserOnline(online: boolean) {
  browserOnline = online;
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

/** Disabled by its own attribute or by a disabled fieldset around it. */
const isDisabled = (element: HTMLElement) => element.matches(':disabled');

afterEach(() => {
  setBrowserOnline(true);
  cleanup();
});

describe('online-only controls', () => {
  it('disable an online-only row with an Offline note, leave other rows alone, and recover', () => {
    render(
      h('div', null, [
        h(MenuRow, { key: 'save', icon: null, label: 'Save', description: '', onlineOnly: true }),
        h(MenuRow, { key: 'lyrics', icon: null, label: 'Lyrics', description: '' }),
      ]),
    );
    const save = screen.getByRole('button', { name: /Save/ });
    const lyrics = screen.getByRole('button', { name: /Lyrics/ });

    setBrowserOnline(false);
    expect(isDisabled(save)).toBe(true);
    expect(save.textContent).toContain('Offline');
    expect(isDisabled(lyrics)).toBe(false);

    setBrowserOnline(true);
    expect(isDisabled(save)).toBe(false);
    expect(save.textContent).not.toContain('Offline');
  });

  it('disable every control inside an online-only region', () => {
    render(
      h(OnlineOnly, null, [
        h('button', { key: 'start', type: 'button' }, 'Start Session'),
        h('input', { key: 'name', 'aria-label': 'Name' }),
      ]),
    );

    setBrowserOnline(false);
    expect(isDisabled(screen.getByRole('button', { name: 'Start Session' }))).toBe(true);
    expect(isDisabled(screen.getByRole('textbox', { name: 'Name' }))).toBe(true);

    setBrowserOnline(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Start Session' }))).toBe(false);
  });
});
