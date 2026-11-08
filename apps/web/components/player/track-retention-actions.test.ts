// @vitest-environment jsdom

// The header's two retention controls report different shelves, and starring is
// the case that separates them: it makes a Track Saved without filing it into
// any Playlist the Library lists.

import { createElement as h } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TrackRetentionActions } from './track-retention-actions';

afterEach(cleanup);

/** The row's icon buttons carry tooltips, whose timing the root layout owns. */
function renderActions(
  props: { favorited: boolean; inCuratedPlaylist: boolean } & Partial<
    Parameters<typeof TrackRetentionActions>[0]
  >,
) {
  const view = render(
    h(
      TooltipProvider,
      null,
      h(TrackRetentionActions, {
        disabled: false,
        onAddToPlaylist: () => {},
        onToggleFavorite: () => {},
        ...props,
      }),
    ),
  );
  return {
    favorite: view.getByTestId('player-favorite'),
    addToPlaylist: view.getByTestId('player-add-to-playlist'),
  };
}

describe('TrackRetentionActions', () => {
  it('leaves Add to Playlist dark for a Track that is only starred', () => {
    const { favorite, addToPlaylist } = renderActions({
      favorited: true,
      inCuratedPlaylist: false,
    });

    expect(favorite.getAttribute('aria-pressed')).toBe('true');
    expect(addToPlaylist.getAttribute('aria-pressed')).toBe('false');
  });

  it('lights Add to Playlist for a filed Track, starred or not', () => {
    const { favorite, addToPlaylist } = renderActions({
      favorited: false,
      inCuratedPlaylist: true,
    });

    expect(addToPlaylist.getAttribute('aria-pressed')).toBe('true');
    expect(favorite.getAttribute('aria-pressed')).toBe('false');
  });

  // Both controls are the same chassis, differing only in the props threaded
  // through it, so a swapped handler is a live mistake the row cannot show.
  it('routes each control to its own handler', () => {
    const onAddToPlaylist = vi.fn();
    const onToggleFavorite = vi.fn();
    const { favorite, addToPlaylist } = renderActions({
      favorited: false,
      inCuratedPlaylist: false,
      onAddToPlaylist,
      onToggleFavorite,
    });

    favorite.click();
    addToPlaylist.click();

    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onAddToPlaylist).toHaveBeenCalledTimes(1);
  });

  it('disables both while the deck carries no Track', () => {
    const { favorite, addToPlaylist } = renderActions({
      favorited: false,
      inCuratedPlaylist: false,
      disabled: true,
    });

    expect((favorite as HTMLButtonElement).disabled).toBe(true);
    expect((addToPlaylist as HTMLButtonElement).disabled).toBe(true);
  });
});
