// @vitest-environment jsdom

// The options sheet's rendering contract: it names what the next tap will
// touch, a roadmap row keeps its place tagged and untappable, the one value row
// unfolds its choice in place instead of leaving the sheet, and a row that
// hands off to a modal pins the action it was tapped with — playback may
// advance while the modal is up.

import { createElement as h } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYLIST_OPTIONS_SCOPES,
  SESSION_OPTIONS_SCOPES,
  type AvailableSessionOptionsId,
} from './player-options-model';
import { trackScopeActions, type OptionsRowAction } from './player-options-rows';
import { PlayerOptionsSheet } from './player-options-sheet';

afterEach(cleanup);

const TRACK = { trackId: 'track-1', title: 'KI statt Gute Nacht' };

function sessionActions(
  overrides: Partial<Record<AvailableSessionOptionsId, OptionsRowAction>> = {},
): Record<AvailableSessionOptionsId, OptionsRowAction> {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
    lyrics: { kind: 'button', onSelect: noop },
    'add-to-playlists': { kind: 'button', onSelect: noop },
    'section-loop': { kind: 'button', onSelect: noop },
    'reroll-track': { kind: 'button', onSelect: noop },
    'more-like-this-track': {
      kind: 'confirm',
      heading: 'More Like This',
      body: 'Start a new Session seeded from this Track?',
      confirmLabel: 'Start new Session',
      onConfirm: asyncNoop,
    },
    'rename-track': { kind: 'button', onSelect: noop },
    'track-data': { kind: 'button', onSelect: noop },
    'download-track': { kind: 'button', onSelect: noop },
    'convert-session-to-playlist': { kind: 'button', onSelect: noop },
    'download-session': { kind: 'button', onSelect: noop },
    'delete-track': {
      kind: 'confirm',
      heading: 'Delete Track',
      body: 'Permanently delete this Track?',
      confirmLabel: 'Delete',
      onConfirm: asyncNoop,
    },
    'change-vibe': { kind: 'button', onSelect: noop },
    'sleep-timer': { kind: 'button', onSelect: noop },
    'rename-session': { kind: 'button', onSelect: noop },
    'session-cover': { kind: 'button', onSelect: noop },
    'delete-session': {
      kind: 'confirm',
      heading: 'Delete Session',
      body: 'Permanently delete this Session?',
      confirmLabel: 'Delete',
      onConfirm: asyncNoop,
    },
    ...overrides,
  };
}

/** Renders the sheet and opens it — a sheet under review is a sheet that is up. */
function renderSessionSheet(
  actions: Record<AvailableSessionOptionsId, OptionsRowAction>,
  {
    lyricsAvailable = true,
    onOpenLyrics = () => {},
  }: { lyricsAvailable?: boolean; onOpenLyrics?: () => void } = {},
) {
  const view = render(
    h(PlayerOptionsSheet, {
      sourceKind: 'Session',
      sourceName: 'John nervt mit KI',
      coverImageId: null,
      trackTitle: TRACK.title,
      tiles: {
        lyrics: { disabled: !lyricsAvailable, onSelect: onOpenLyrics },
        blend: { enabled: true, onToggle: () => {} },
        sourceCover: {
          label: 'Session Cover',
          hint: 'Upload one or generate it',
          testId: 'player-regenerate-cover',
          onSelect: () => {},
        },
        addToPlaylist: { disabled: false, onSelect: () => {} },
      },
      scopes: SESSION_OPTIONS_SCOPES,
      actions,
    }),
  );
  act(() => row(/Session and Track options/).click());
  return view;
}

function row(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

describe('player options sheet', () => {
  it.each(['vocal', 'instrumental', 'empty'])(
    'gives Playlist playback three tiles and a Lyrics row (%s)',
    (trackKind) => {
      const onOpenLyrics = vi.fn();
      render(
        h(PlayerOptionsSheet, {
          sourceKind: 'Playlist',
          sourceName: 'Night',
          coverImageId: null,
          trackTitle: trackKind === 'empty' ? null : TRACK.title,
          tiles: {
            blend: { enabled: true, onToggle: () => {} },
            sourceCover: {
              label: 'Playlist Cover',
              testId: 'playlist-cover',
              hint: 'Manage cover',
              onSelect: () => {},
            },
            addToPlaylist: { disabled: trackKind === 'empty', onSelect: () => {} },
          },
          scopes: PLAYLIST_OPTIONS_SCOPES,
          actions: trackScopeActions({
            track: trackKind === 'empty' ? null : { ...TRACK, downloadable: true },
            lyricsAvailable: trackKind === 'vocal',
            onOpenLyrics,
            onRenameTrack: async () => null,
            onOpenTrackData: () => {},
          }),
        }),
      );
      act(() => row(/Playlist and Track options/).click());
      expect(
        screen.getByTestId('player-open-lyrics').closest('[role="dialog"]')?.textContent,
      ).toContain('Read along with this track');
      expect(
        screen.getByTestId('playlist-cover').parentElement?.querySelectorAll('button'),
      ).toHaveLength(3);
      const lyrics = screen.getByTestId('player-open-lyrics') as HTMLButtonElement;
      expect(lyrics.parentElement?.textContent).toContain('This Track');
      expect(lyrics.disabled).toBe(trackKind !== 'vocal');
      act(() => lyrics.click());
      if (trackKind === 'vocal') {
        expect(onOpenLyrics).toHaveBeenCalledOnce();
        expect(screen.queryByRole('dialog')).toBeNull();
      } else expect(onOpenLyrics).not.toHaveBeenCalled();
    },
  );

  it('names the Track it acts on and the source it plays inside', () => {
    renderSessionSheet(sessionActions());

    expect(screen.getByText(TRACK.title)).toBeTruthy();
    expect(screen.getByText(/^in Session/).textContent).toBe('in Session John nervt mit KI');
  });

  it('keeps the Lyrics tile in its slot on an instrumental Track, greyed out', () => {
    renderSessionSheet(sessionActions(), { lyricsAvailable: false });

    expect((screen.getByTestId('player-open-lyrics') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps an unavailable row in place, untappable', () => {
    renderSessionSheet(
      sessionActions({
        'download-track': { kind: 'unavailable', testId: 'player-download-track' },
      }),
    );

    const downloadTrack = row(/Download Track/);
    expect(downloadTrack.disabled).toBe(true);
  });

  it('runs a shipped row’s action', () => {
    const onSelect = vi.fn();
    renderSessionSheet(sessionActions({ 'rename-session': { kind: 'button', onSelect } }));

    act(() => row(/Rename Session/).click());

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('leads a Session’s tiles with Lyrics, repeats it as a row, and closes the sheet to open it', () => {
    const onOpenLyrics = vi.fn();
    renderSessionSheet(sessionActions(), { onOpenLyrics });
    const lyrics = screen.getByTestId('player-open-lyrics');
    const cover = screen.getByTestId('player-regenerate-cover');

    expect(lyrics.compareDocumentPosition(cover) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The tile, and the row a listener reading the list finds it by.
    expect(screen.getAllByText('Lyrics')).toHaveLength(2);
    expect(screen.getByText('Read along with this track')).toBeTruthy();

    act(() => lyrics.click());

    expect(onOpenLyrics).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the Lyrics tile usable offline, where the tiles that write are not, and says why', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      renderSessionSheet(sessionActions());
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });

      expect(screen.getByTestId('player-open-lyrics').matches(':disabled')).toBe(false);
      expect(screen.getByTestId('player-regenerate-cover').matches(':disabled')).toBe(true);
      // The header says why the sheet is short.
      expect(screen.getByRole('button', { name: /Offline: why options are missing/ })).toBeTruthy();
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
    }
  });

  it('renames through the action the row was tapped with', async () => {
    const onRename = vi.fn(async () => null);
    renderSessionSheet(
      sessionActions({
        'rename-track': {
          kind: 'rename',
          heading: 'Rename Track',
          currentName: TRACK.title,
          maxLength: 80,
          onRename,
        },
      }),
    );

    act(() => row(/Rename Track/).click());

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe(TRACK.title);
  });

  it('asks first before a destructive row acts', () => {
    const onConfirm = vi.fn(async () => {});
    renderSessionSheet(
      sessionActions({
        'rename-session': {
          kind: 'confirm',
          heading: 'Delete Session',
          body: 'Deletes its Tracks unless you saved them.',
          confirmLabel: 'Delete',
          onConfirm,
        },
      }),
    );

    act(() => row(/Rename Session/).click());

    expect(screen.getByTestId('confirm-dialog').textContent).toContain(
      'Deletes its Tracks unless you saved them.',
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
