// @vitest-environment jsdom

// Available offline sits at the top of every options menu that reaches a
// Playlist or Session: My Sessions and both Player sources. In the Player the
// one-tap tiles stay above the list, and a Session's New music row, the one
// control over what it spends, comes just before the switch.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem, SessionListItem } from '@liedmotif/shared';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { presentNewMusicStatus } from '@/components/player/new-music-status';
import { PlayerSessionOptions } from '@/components/player/player-session-options';
import { PlaylistOptions } from '@/components/player/playlist-options';
import { SessionOptionsSheet } from '@/components/sessions/session-options-sheet';
import { Sheet } from '@/components/ui/sheet';

vi.mock('@/lib/offline/offline-support', () => ({ offlineSupported: () => true }));
vi.mock('@/lib/offline/device-offline', () => ({
  subscribeOfflineStatus: () => () => undefined,
  offlineStatusSnapshot: () => new Map(),
  deviceOffline: vi.fn(),
}));
// Lazily loaded and needs the app shell: left real, it throws whenever its import
// settles before the test ends, which makes these tests depend on load timing.
vi.mock('@/components/player/regenerate-cover-dialog', () => ({
  RegenerateCoverDialog: () => null,
}));

afterEach(cleanup);

const noop = () => {};
const succeed = async () => null;
const complete = async () => {};

function SessionInPlayer() {
  return h(PlayerSessionOptions, {
    sessionId: 'session-1',
    sessionTitle: 'Night',
    coverImageId: null,
    newMusicStatus: presentNewMusicStatus({
      session: { sessionMode: 'repeat' },
      generatingAhead: 0,
      generationStatus: 'ok',
    }),
    onOpenNewMusic: noop,
    actionError: null,
    busy: false,
    onStop: noop,
    lyricsAvailable: false,
    onOpenLyrics: noop,
    onOpenTrackData: noop,
    track: null,
    onConvertToPlaylist: noop,
    onRenameSession: succeed,
    onRenameTrack: succeed,
    onReroll: noop,
    onMoreLikeThis: complete,
    moreLikeThisAvailable: true,
    onOpenChangeVibe: noop,
    changeVibeAvailable: true,
    onDeleteTrack: complete,
    onDeleteSession: complete,
    blendEnabled: true,
    onToggleBlend: noop,
    onAddTrackToPlaylist: noop,
    sleepTimerEndsAt: null,
    sectionLoop: { open: false, available: true, onToggle: () => {} },
  });
}

const PLAYLIST = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Late Drive',
  kind: 'user',
  coverImageId: null,
  mosaicCoverImageIds: [],
} as unknown as PlaylistSummaryItem;

function playlistInPlayer() {
  return h(PlaylistOptions, {
    playlist: PLAYLIST,
    visitor: false,
    coverImageId: null,
    track: null,
    lyricsAvailable: false,
    onOpenLyrics: noop,
    onOpenTrackData: noop,
    blendEnabled: true,
    onToggleBlend: noop,
    onAddTrackToPlaylist: noop,
    onCoverChanged: noop,
    onRenameTrack: succeed,
    onRenamePlaylist: succeed,
    onRemoveTrack: complete,
    onDeleteTrack: complete,
    onMoreLikeThis: noop,
    moreLikeThisAvailable: true,
    onDeletePlaylist: complete,
    sleepTimerEndsAt: null,
    sectionLoop: { open: false, available: true, onToggle: () => {} },
  });
}

function expectFirst(before: HTMLElement, after: HTMLElement) {
  expect(before.compareDocumentPosition(after)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('options menus keep Available offline at the top', () => {
  it('in My Sessions, above Resume Session', () => {
    render(
      h(
        Sheet,
        { open: true },
        h(SessionOptionsSheet, {
          session: {
            id: 'session-1',
            title: 'Late Drive',
            trackCount: 4,
            genreTags: [],
          } as unknown as SessionListItem,
          error: null,
          resuming: false,
          deleting: false,
          converting: false,
          pinning: false,
          onResume: noop,
          onTogglePin: noop,
          onRename: noop,
          onChangeCover: noop,
          onConvertToPlaylist: noop,
          onDelete: complete,
        }),
      ),
    );
    expectFirst(screen.getByTestId('offline-toggle'), screen.getByText('Resume Session'));
  });

  it('for a Session in the Player, under the tiles and above the list', () => {
    render(h(SessionInPlayer));
    act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());

    const dialog = within(screen.getByRole('dialog'));
    const toggle = dialog.getByTestId('offline-toggle');
    expectFirst(dialog.getByTestId('player-regenerate-cover'), toggle);
    expectFirst(dialog.getByTestId('player-new-music-row'), toggle);
    expectFirst(toggle, dialog.getByText('This Track'));
  });

  it('for a Playlist in the Player, under the tiles and above the list', () => {
    render(playlistInPlayer());
    act(() => screen.getByRole('button', { name: 'Playlist and Track options' }).click());

    const dialog = within(screen.getByRole('dialog'));
    const toggle = dialog.getByTestId('offline-toggle');
    expectFirst(dialog.getByTestId('player-add-track-to-playlist'), toggle);
    expectFirst(toggle, dialog.getByText('This Track'));
  });
});
