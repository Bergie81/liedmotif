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
import { SessionModeToggleTile } from './session-mode-control';
import { PlayerOptionsSheet } from './player-options-sheet';

afterEach(cleanup);

const TRACK = { trackId: 'track-1', title: 'KI statt Gute Nacht' };

function sessionActions(
  overrides: Partial<Record<AvailableSessionOptionsId, OptionsRowAction>> = {},
): Record<AvailableSessionOptionsId, OptionsRowAction> {
  const noop = () => {};
  const asyncNoop = async () => {};
  return {
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
    lyrics: { kind: 'button', testId: 'player-open-lyrics', onSelect: noop },
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
  { lyricsAvailable = true }: { lyricsAvailable?: boolean } = {},
) {
  const view = render(
    h(PlayerOptionsSheet, {
      sourceKind: 'Session',
      sourceName: 'John nervt mit KI',
      coverImageId: null,
      trackTitle: TRACK.title,
      tiles: {
        modeToggle: h(SessionModeToggleTile, {
          sessionMode: 'repeat',
          pending: false,
          disabled: false,
          onToggle: () => {},
        }),
        blend: { enabled: true, onToggle: () => {} },
        sourceCover: {
          label: 'Session Cover',
          hint: 'Reroll Cover Art',
          testId: 'player-regenerate-cover',
          onSelect: () => {},
        },
        addToPlaylist: { disabled: false, onSelect: () => {} },
      },
      scopes: SESSION_OPTIONS_SCOPES,
      actions: {
        ...actions,
        ...(!lyricsAvailable
          ? { lyrics: { kind: 'unavailable', testId: 'player-open-lyrics' } as const }
          : {}),
      },
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
      expect(screen.queryByTestId('player-session-mode-menu-toggle')).toBeNull();
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

  it('keeps the Lyrics row first under This Track on an instrumental Track, greyed out', () => {
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

  it('puts the mode toggle first above Lyrics and keeps options open when toggled', () => {
    renderSessionSheet(sessionActions());
    const mode = screen.getByTestId('player-session-mode-menu-toggle');
    const cover = screen.getByTestId('player-regenerate-cover');
    const lyrics = screen.getByTestId('player-open-lyrics');
    expect(mode.compareDocumentPosition(cover) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cover.compareDocumentPosition(lyrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lyrics.parentElement?.textContent).toContain('This Track');
    act(() => mode.click());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText('Session mode')).toBeNull();
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
