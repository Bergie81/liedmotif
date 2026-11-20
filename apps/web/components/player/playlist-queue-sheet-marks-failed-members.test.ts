// @vitest-environment jsdom

// A failed member's final never arrived: the playing Playlist's Track list
// names it with the same notice as the Playlist page, never as a healthy row.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistQueueSheet } from './playlist-queue-sheet';

afterEach(cleanup);

describe('PlaylistQueueSheet — a failed member', () => {
  it('shows that the Track could not be kept in place of its length', () => {
    render(
      h(PlaylistQueueSheet, {
        open: true,
        onOpenChange: vi.fn(),
        playlistName: 'Beach',
        tracks: [
          {
            id: 'ok',
            title: 'Kept',
            coverImageId: null,
            durationSeconds: 125,
            audioUrl: '/api/audio/ok',
            status: 'ready',
          },
          {
            id: 'lost',
            title: 'Lost',
            coverImageId: null,
            durationSeconds: 125,
            audioUrl: null,
            status: 'failed',
          },
        ],
        currentTrackId: 'ok',
        onPlayTrack: vi.fn(),
      }),
    );

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]!.textContent).not.toContain('Could Not Be Kept');
    expect(rows[1]!.textContent).toContain('Could Not Be Kept');
  });
});
