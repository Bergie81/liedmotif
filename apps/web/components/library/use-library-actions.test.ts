// @vitest-environment jsdom

// What a settled retention write tells a Library row. Both shelves live on the
// row at once and only one action moves each: the star moves the Save floor,
// the save picker moves curated membership. An action that reported the other
// shelf's state would make the row's Add to Playlist lie.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { LibraryTrackItem, TrackFlags } from '@liedmotif/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { shownToasts, toast } from '@/lib/toast';
import { useLibraryActions } from './use-library-actions';

// More Like This needs a router and the player provider; retention writes do not.
vi.mock('@/components/sessions/use-seed-more-like-this', () => ({
  useSeedMoreLikeThis: () => async () => null,
}));

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

const TRACK_ID = '00000000-0000-4000-8000-000000000001';

/** A Track already filed into a Playlist the owner curates, and not starred. */
function filedTrack(): LibraryTrackItem {
  return {
    id: TRACK_ID,
    savedAt: '2026-07-24T10:00:00.000Z',
    favoritedAt: null,
    inCuratedPlaylist: true,
  } as unknown as LibraryTrackItem;
}

function flags(overrides: Partial<TrackFlags> = {}): TrackFlags {
  return {
    trackId: TRACK_ID,
    savedAt: '2026-07-24T10:00:00.000Z',
    favoritedAt: null,
    dislikedAt: null,
    retentionClass: 'durable',
    ...overrides,
  };
}

function renderActions() {
  const resolved = vi.fn();
  const view = renderHook(() =>
    useLibraryActions({ view: 'history', onFlagsResolved: resolved, onTrackRemoved: vi.fn() }),
  );
  return { resolved, result: view.result };
}

describe('useLibraryActions retention', () => {
  it('keeps curated membership across a Favorite write', async () => {
    const requests = captureFetches();
    const { resolved, result } = renderActions();

    act(() => void result.current.toggleFavorite(filedTrack()));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () =>
      requests[0]!.respond({
        ok: true,
        data: flags({ favoritedAt: '2026-07-24T11:00:00.000Z' }),
      }),
    );

    // Starring cannot file a Track into a curated Playlist, so reporting `false`
    // here would darken the row's Add to Playlist on every star.
    await waitFor(() => expect(resolved).toHaveBeenCalledTimes(1));
    expect(resolved.mock.calls[0]![2]).toBe(true);
  });

  it('clears curated membership when Unsave leaves every Playlist', async () => {
    const requests = captureFetches();
    const { resolved, result } = renderActions();

    act(() => void result.current.unsave(filedTrack()));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () =>
      requests[0]!.respond({
        ok: true,
        data: flags({ savedAt: null, retentionClass: 'ephemeral' }),
      }),
    );

    await waitFor(() => expect(resolved).toHaveBeenCalledTimes(1));
    expect(resolved.mock.calls[0]![2]).toBe(false);
  });

  it('takes curated membership from the save picker’s own result', async () => {
    const { resolved, result } = renderActions();

    act(() => result.current.applyPickerFlags(TRACK_ID, flags(), true));

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved.mock.calls[0]![2]).toBe(true);
  });
});

// A failed write is an event, not a state of the row: it floats as a toast, so
// the list and the options sheet above it stay where they are.

describe('useLibraryActions failures', () => {
  const NETWORK_DOWN = {
    ok: false,
    error: { code: 'internal_error', message: 'Network down.', retryable: true },
  };

  it('reports a failed Favorite as an error toast that a successful retry clears', async () => {
    const requests = captureFetches();
    const { resolved, result } = renderActions();

    act(() => void result.current.toggleFavorite(filedTrack()));
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(NETWORK_DOWN));

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Favorite change failed: Network down.' }),
    ]);
    expect(resolved).not.toHaveBeenCalled();

    act(() => void result.current.toggleFavorite(filedTrack()));
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () =>
      requests[1]!.respond({ ok: true, data: flags({ favoritedAt: '2026-07-24T11:00:00.000Z' }) }),
    );

    await waitFor(() => expect(resolved).toHaveBeenCalledTimes(1));
    expect(shownToasts()).toEqual([]);
  });

  it('reports a failed delete as one error toast that a failed retry replaces', async () => {
    const requests = captureFetches();
    const { result } = renderActions();

    let deleted: Promise<boolean> | undefined;
    act(() => {
      deleted = result.current.deleteTrack(filedTrack());
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(NETWORK_DOWN));
    expect(await deleted).toBe(false);

    act(() => void result.current.deleteTrack(filedTrack()));
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () =>
      requests[1]!.respond({
        ok: false,
        error: { code: 'not_found', message: 'Track not found.', retryable: false },
      }),
    );

    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Delete failed: Track not found.' }),
    ]);
  });
});
