// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistMemberItem, PlaylistSummaryItem } from '@liedmotif/shared';
import { announceOutsideLibraryWrite } from '@/lib/offline/library-writes';
import { usePlaylistMembers } from './use-playlist-members';

const api = vi.hoisted(() => ({
  getPlaylist: vi.fn(),
  getAllPlaylistMembers: vi.fn(),
  removePlaylistTrack: vi.fn(),
}));
vi.mock('@/lib/api-client', () => api);
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const PLAYLIST_ID = '00000000-0000-4000-8000-00000000aaaa';

function summary(over: Partial<PlaylistSummaryItem> = {}): PlaylistSummaryItem {
  return {
    id: PLAYLIST_ID,
    name: 'Focus',
    kind: 'user',
    listedInPlaylists: true,
    trackCount: 3,
    totalDurationSeconds: 540,
    downloadableTrackCount: 3,
    coverImageId: null,
    mosaicCoverImageIds: [],
    soleMemberTrackCount: 0,
    soleMemberDeletedTrackCount: 0,
    containsTrack: null,
    sharedAt: null,
    pinnedAt: null,
    createdAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-30T10:00:00.000Z',
    ...over,
  };
}

function member(id: string, position: number): PlaylistMemberItem {
  return {
    id: `00000000-0000-4000-8000-0000000000${id}`,
    title: 'Track',
    generatedArtistName: null,
    status: 'ready',
    durationSeconds: 180,
    coverImageId: null,
    audioUrl: null,
    savedAt: '2026-07-30T10:00:00.000Z',
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: [],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    position,
    originSessionTitle: null,
    owner: null,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  router.refresh.mockClear();
});

function renderMembers(initialItems: PlaylistMemberItem[], trackCount: number) {
  const onError = vi.fn();
  const onUnsaved = vi.fn();
  const view = renderHook(() =>
    usePlaylistMembers({
      playlistId: PLAYLIST_ID,
      initial: { playlist: summary({ trackCount }), items: initialItems },
      onError,
      onUnsaved,
    }),
  );
  return { ...view, onError, onUnsaved };
}

describe('usePlaylistMembers', () => {
  it('derives hasMore from the live count and appends the next page by position cursor', async () => {
    const { result } = renderMembers([member('01', 0), member('02', 1)], 3);
    expect(result.current.hasMore).toBe(true);

    api.getPlaylist.mockResolvedValueOnce({
      ok: true,
      data: {
        playlist: summary({ trackCount: 3 }),
        items: [member('03', 2)],
        nextCursor: null,
      },
    });
    await act(async () => result.current.loadMore());

    expect(api.getPlaylist).toHaveBeenCalledWith(PLAYLIST_ID, '1', expect.any(Number));
    expect(result.current.items).toHaveLength(3);
    expect(result.current.hasMore).toBe(false);
  });

  it('tells the last-removal notice whether the Track was deleted for good', async () => {
    api.removePlaylistTrack.mockResolvedValueOnce({
      ok: true,
      data: { removed: true, unsaved: true, deletedForGood: true },
    });
    const only = member('01', 0);
    const { result, onUnsaved } = renderMembers([only], 1);

    act(() => result.current.removeMember(only.id));

    await waitFor(() =>
      expect(onUnsaved).toHaveBeenCalledWith({ deletedForGood: true, sharedReference: false }),
    );
  });

  it('holds paging while an optimistic removal commits, then pages from the reindexed prefix', async () => {
    let settleRemove!: (value: unknown) => void;
    api.removePlaylistTrack.mockReturnValueOnce(
      new Promise((resolve) => {
        settleRemove = resolve;
      }),
    );
    const second = member('02', 1);
    const { result } = renderMembers([member('01', 0), second], 3);

    act(() => result.current.removeMember(second.id));
    expect(result.current.removing).toBe(true);
    // The loaded prefix reindexed dense and the summary followed the removal.
    expect(result.current.items?.map((item) => item.position)).toEqual([0]);
    expect(result.current.playlist?.trackCount).toBe(2);
    expect(result.current.playlist?.totalDurationSeconds).toBe(360);
    expect(result.current.playlist?.downloadableTrackCount).toBe(2);

    // Paging is refused while the removal is in flight (pre-resequence reads
    // would resurrect the removed row).
    await act(async () => result.current.loadMore());
    expect(api.getPlaylist).not.toHaveBeenCalled();

    await act(async () => {
      settleRemove({ ok: true, data: { unsaved: false } });
    });
    await waitFor(() => expect(result.current.removing).toBe(false));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The next cursor now derives from the reindexed prefix: position 0.
    api.getPlaylist.mockResolvedValueOnce({
      ok: true,
      data: { playlist: summary({ trackCount: 2 }), items: [member('03', 1)], nextCursor: null },
    });
    await act(async () => result.current.loadMore());
    expect(api.getPlaylist).toHaveBeenCalledWith(PLAYLIST_ID, '0', expect.any(Number));
  });

  it('rolls the list and summary back when a removal fails', async () => {
    api.removePlaylistTrack.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal_error', message: 'nope' },
    });
    const second = member('02', 1);
    const { result, onError } = renderMembers([member('01', 0), second], 2);

    await act(async () => {
      result.current.removeMember(second.id);
    });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(result.current.items?.map((item) => item.position)).toEqual([0, 1]);
    expect(result.current.playlist?.trackCount).toBe(2);
    expect(result.current.playlist?.totalDurationSeconds).toBe(540);
    expect(result.current.playlist?.downloadableTrackCount).toBe(3);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('reloads the Playlist and its Tracks when a write comes from outside the page', async () => {
    const { result } = renderMembers([member('01', 0)], 1);
    api.getPlaylist.mockResolvedValueOnce({
      ok: true,
      data: {
        playlist: summary({ name: 'Renamed', trackCount: 2 }),
        items: [member('01', 0), member('02', 1)],
        nextCursor: null,
      },
    });

    act(() => announceOutsideLibraryWrite());

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.playlist?.name).toBe('Renamed');
  });
});
