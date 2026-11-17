// @vitest-environment jsdom

// Available offline is the first thing the Playlist's menu offers, on the
// listener's own Playlist and on a Lounge visitor's alike. A header with no
// other rows has the menu only when this page can store music at all.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaylistHeader } from './playlist-header';
import type { PlaylistMenuRowId } from './playlist-view-model';

const supported = vi.hoisted(() => ({ current: true }));

vi.mock('@/lib/offline/offline-support', () => ({
  offlineSupported: () => supported.current,
}));
vi.mock('@/lib/offline/device-offline', () => ({
  subscribeOfflineStatus: () => () => undefined,
  offlineStatusSnapshot: () => new Map(),
  deviceOffline: vi.fn(),
}));

beforeEach(() => {
  supported.current = true;
});
afterEach(cleanup);

const PLAYLIST: PlaylistSummaryItem = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Late Drive',
  kind: 'user',
  listedInPlaylists: true,
  trackCount: 3,
  totalDurationSeconds: 540,
  downloadableTrackCount: 3,
  coverImageId: null,
  mosaicCoverImageIds: [],
  soleMemberTrackCount: 0,
  containsTrack: null,
  sharedAt: null,
  pinnedAt: null,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
};

const OWNER_ACTIONS: Record<PlaylistMenuRowId, () => void> = {
  'add-tracks': vi.fn(),
  rename: vi.fn(),
  reorder: vi.fn(),
  cover: vi.fn(),
  download: vi.fn(),
  delete: vi.fn(),
};

describe('the Playlist menu', () => {
  it('offers Available offline before every other row', () => {
    render(h(PlaylistHeader, { playlist: PLAYLIST, reordering: false, actions: OWNER_ACTIONS }));
    fireEvent.click(screen.getByTestId('playlist-menu'));

    const toggle = screen.getByTestId('offline-toggle');
    const firstAct = screen.getByTestId('playlist-menu-add-tracks');
    expect(toggle.compareDocumentPosition(firstAct)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('holds only Available offline when there are no other rows', () => {
    render(h(PlaylistHeader, { playlist: PLAYLIST, reordering: false }));
    fireEvent.click(screen.getByTestId('playlist-menu'));

    expect(screen.getByTestId('offline-toggle')).toBeTruthy();
    expect(screen.queryByTestId('playlist-menu-add-tracks')).toBeNull();
  });

  it('is absent with no other rows where the page cannot store music', () => {
    supported.current = false;
    render(h(PlaylistHeader, { playlist: PLAYLIST, reordering: false }));

    expect(screen.queryByTestId('playlist-menu')).toBeNull();
  });

  it('keeps its other rows for the owner where the page cannot store music', () => {
    supported.current = false;
    render(h(PlaylistHeader, { playlist: PLAYLIST, reordering: false, actions: OWNER_ACTIONS }));
    fireEvent.click(screen.getByTestId('playlist-menu'));

    expect(screen.queryByTestId('offline-toggle')).toBeNull();
    expect(screen.getByTestId('playlist-menu-add-tracks')).toBeTruthy();
  });
});
