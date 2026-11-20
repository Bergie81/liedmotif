import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LibraryNavigation } from './library-navigation';
import { LibraryView } from './library-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Playback needs a PlayerProvider ancestor; this suite only renders markup.
vi.mock('@/components/playlists/use-play-playlist', () => ({
  usePlayPlaylist: () => ({ play: vi.fn() }),
}));

describe('Library navigation', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  it('renders no search input of its own — search lives inside each tab', () => {
    const markup = renderToStaticMarkup(
      React.createElement(LibraryNavigation, {
        view: 'saved',
        currentCount: null,
        hasMore: false,
        onChange: () => undefined,
      }),
    );

    expect(markup).not.toContain('<input');
  });

  it('the Playlists tab carries its own search field', () => {
    const markup = renderToStaticMarkup(React.createElement(LibraryView));

    expect(markup).toMatch(/<input[^>]*type="search"/);
    expect(markup).toMatch(/placeholder="Search playlists and their tracks…"/);
  });

  it('opens on Playlists and offers Playlists, Saved and History, in that order', () => {
    const markup = renderToStaticMarkup(React.createElement(LibraryView));
    const tabs = [...markup.matchAll(/<button[^>]*aria-pressed="[^"]*"[^>]*>([^<]+)/g)].map(
      (match) => match[1],
    );

    expect(markup).toMatch(/aria-pressed="true"[^>]*>Playlists/);
    // Favorites is a card in the Playlists grid, not a tab of its own.
    expect(tabs).toEqual(['Playlists', 'Saved', 'History']);
  });

  it('shows the count on the active tab only — Playlists included', () => {
    for (const view of ['playlists', 'saved', 'history'] as const) {
      const markup = renderToStaticMarkup(
        React.createElement(LibraryNavigation, {
          view,
          currentCount: 7,
          hasMore: false,
          onChange: () => undefined,
        }),
      );

      expect(markup.match(/>7</g)).toHaveLength(1);
      expect(markup).toMatch(/aria-pressed="true"[^>]*>[^<]*<span[^>]*><span[^>]*>7</);
      // The badge must not widen the tab when the count arrives.
      expect(markup).toMatch(/aria-pressed="true"[^>]*>[^<]*<span class="[^"]*\bw-0\b/);
    }
  });

  it('shows no count while it is still unknown', () => {
    const markup = renderToStaticMarkup(
      React.createElement(LibraryNavigation, {
        view: 'saved',
        currentCount: null,
        hasMore: false,
        onChange: () => undefined,
      }),
    );

    expect(markup).not.toContain('<span');
  });

  it('marks a truncated count with a plus', () => {
    const markup = renderToStaticMarkup(
      React.createElement(LibraryNavigation, {
        view: 'saved',
        currentCount: 50,
        hasMore: true,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('>50+<');
  });

  it('does not show genre facets on any Library tab', () => {
    for (const view of ['playlists', 'saved', 'history'] as const) {
      const markup = renderToStaticMarkup(
        React.createElement(LibraryNavigation, {
          view,
          currentCount: 0,
          hasMore: false,
          onChange: () => undefined,
        }),
      );

      for (const facet of [
        '>All<',
        '>Ambient<',
        '>Jazz<',
        '>D&amp;B<',
        '>Focus<',
        '>Running<',
        '>Sleep<',
        '>Instrumental<',
      ]) {
        expect(markup).not.toContain(facet);
      }
    }
  });
});
