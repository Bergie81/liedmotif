// @vitest-environment jsdom

// The header's action row is shared by both Playback sources, so the parts only
// one of them has ride in as slots. The Session player fills the New Music slot
// from its session summary; the Playlist player generates nothing and passes
// nothing, which leaves only the shared controls in the row.

import { act, createElement as h, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlayerHeader } from './player-header';
import { presentNewMusicStatus } from './new-music-status';
import { NewMusicStatusButton } from './new-music-status-button';

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
function header(newMusic?: ReactNode, statusChange: string | null = null) {
  return h(
    TooltipProvider,
    null,
    h(PlayerHeader, {
      statusChange,
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
      newMusic,
    }),
  );
}

const renderHeader = (newMusic?: ReactNode) => render(header(newMusic));

describe('PlayerHeader', () => {
  it('places the New Music status ahead of the blend toggle', () => {
    const view = renderHeader(
      h(NewMusicStatusButton, {
        status: presentNewMusicStatus({
          session: { sessionMode: 'keep_going' },
          generatingAhead: 0,
          generationStatus: 'ok',
        }),
        generatingAhead: 0,
        playableTracks: [],
        onOpen: () => {},
      }),
    );

    const indicator = view.getByTestId('player-new-music');
    const blend = view.getByTestId('player-blend-toggle');
    expect(
      indicator.compareDocumentPosition(blend) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows no New Music status for a source that generates nothing (a Playlist)', () => {
    const view = renderHeader();

    expect(view.queryByTestId('player-new-music')).toBeNull();
    expect(view.getByTestId('player-blend-toggle')).toBeTruthy();
  });

  it('announces a change of direction in its own polite region, as it begins and as it moves on', () => {
    const view = render(header());
    const change = view.getByTestId('player-status-change');
    const playing = view.getByText('PLAYING: Nachtfahrt.');
    expect(change.getAttribute('role')).toBe('status');
    expect(change.getAttribute('aria-live')).toBe('polite');
    expect(change.textContent).toBe('');

    view.rerender(header(undefined, 'Changing vibe…'));
    expect(view.getByTestId('player-status-change')).toBe(change);
    expect(change.textContent).toBe('Changing vibe…');

    view.rerender(header(undefined, 'New vibe queued'));
    expect(change.textContent).toBe('New vibe queued');
    // The Track is not read out again with each step.
    expect(playing.textContent).toBe('PLAYING: Nachtfahrt.');
  });

  it('reads the change once: the line on screen leaves it to the announcement', () => {
    const view = render(header(undefined, 'Changing vibe…'));

    expect(view.getAllByText('Changing vibe…').map((el) => el.getAttribute('aria-hidden'))).toEqual(
      ['true', null],
    );
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
