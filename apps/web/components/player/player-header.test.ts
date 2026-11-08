// @vitest-environment jsdom

// The header's action row is shared by both Playback sources, so the parts only
// one of them has ride in as slots. The Session player fills the mode-toggle
// slot from its session summary; the Playlist player has no Session mode and
// passes nothing, which must leave the row exactly as it was.

import { act, createElement as h, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlayerHeader } from './player-header';
import { SessionModeToggleButton } from './session-mode-control';

beforeAll(() => {
  // The scrambling title/subtitle ask the platform whether motion is welcome;
  // jsdom has no media queries, so answer "no reduction" once.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
});

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

/** The row's icon buttons carry tooltips, whose timing the root layout owns. */
function renderHeader(modeToggle?: ReactNode) {
  return render(
    h(
      TooltipProvider,
      null,
      h(PlayerHeader, {
        statusLabel: 'PLAYING',
        title: 'Nachtfahrt',
        subtitle: 'Liedmotif',
        announcement: 'PLAYING: Nachtfahrt.',
        controls: {
          hasTrack: true,
          player: {
            blendEnabled: true,
            toggleBlend: () => {},
            currentFavorited: false,
            currentInCuratedPlaylist: false,
            toggleFavorite: () => {},
            sectionLoopTool: { phase: 'closed' },
            sectionLoopAvailable: true,
            toggleSectionLoopTool: () => {},
          },
          onAddToPlaylist: () => {},
        },
        options: null,
        modeToggle,
      }),
    ),
  );
}

describe('PlayerHeader', () => {
  it('places the mode toggle ahead of the blend toggle', () => {
    const view = renderHeader(
      h(SessionModeToggleButton, {
        sessionMode: 'keep_going',
        pending: false,
        disabled: false,
        onToggle: () => {},
      }),
    );

    const indicator = view.getByTestId('player-session-mode-toggle');
    const blend = view.getByTestId('player-blend-toggle');
    expect(
      indicator.compareDocumentPosition(blend) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows no mode toggle for a source without one (a Playlist)', () => {
    const view = renderHeader();

    expect(view.queryByTestId('player-session-mode-toggle')).toBeNull();
    expect(view.getByTestId('player-blend-toggle')).toBeTruthy();
  });

  // The blend toggle and both retention actions save on the server: offline
  // they go quiet together, so none can flip and then fail.
  it('disables the blend toggle and the retention actions while offline', () => {
    const view = renderHeader();
    setBrowserOnline(false);

    for (const testId of ['player-blend-toggle', 'player-favorite', 'player-add-to-playlist']) {
      expect(view.getByTestId(testId).matches(':disabled')).toBe(true);
    }
    expect(view.getByTestId('player-section-loop-toggle').matches(':disabled')).toBe(false);
  });
});
