// @vitest-environment jsdom

// The Playlist page's `⋯` opens the same bottom sheet as every other options
// menu: it names the Playlist it acts on, and a picked row hands off to its
// overlay with the sheet already gone, so two surfaces never stack.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistHeader } from './playlist-header';
import type { PlaylistMenuRowId } from './playlist-view-model';

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

function renderHeader(actions: Record<PlaylistMenuRowId, () => void>) {
  render(h(PlaylistHeader, { playlist: PLAYLIST, reordering: false, actions }));
  fireEvent.click(screen.getByTestId('playlist-menu'));
}

function noActions(): Record<PlaylistMenuRowId, () => void> {
  return {
    'add-tracks': vi.fn(),
    rename: vi.fn(),
    reorder: vi.fn(),
    cover: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
  };
}

describe('PlaylistHeader options', () => {
  it('opens a sheet that names the Playlist it acts on', () => {
    renderHeader(noActions());
    const sheet = screen.getByRole('dialog');
    expect(sheet.textContent).toContain('Late Drive');
    expect(sheet.textContent).toContain('3 Tracks · 9 min');
    expect(screen.getByRole('button', { name: 'Close options for Late Drive' })).toBeTruthy();
  });

  it('closes the sheet before handing off to the picked act', () => {
    const actions = noActions();
    renderHeader(actions);
    fireEvent.click(screen.getByTestId('playlist-menu-rename'));
    expect(actions.rename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('PlaylistHeader Play', () => {
  const play = h('button', { type: 'button' }, 'Play');

  it('leaves the header while reordering, whose bar is the only way out', () => {
    render(h(PlaylistHeader, { playlist: PLAYLIST, reordering: true, play, actions: noActions() }));
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.queryByTestId('playlist-menu')).toBeNull();
  });
});
