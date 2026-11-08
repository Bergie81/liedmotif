// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionTracks } from './use-session-tracks';

const FIRST = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'First',
  durationSeconds: 123,
  styleRevision: 1,
};
const SECOND = { ...FIRST, id: '00000000-0000-4000-8000-000000000002', title: 'Second' };
function page(
  items = [FIRST],
  nextCursor: string | null = null,
  total = items.length,
  totalDurationSeconds = 123,
) {
  return {
    ok: true,
    data: { items, nextCursor, total, totalDurationSeconds, genreTags: ['ambient'] },
  };
}
function fetchResponses(...bodies: unknown[]) {
  const fetcher = vi.fn();
  for (const body of bodies) fetcher.mockResolvedValueOnce({ json: async () => body });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Session track browsing', () => {
  it('loads more using the last position, then refreshes all loaded pages without duplicates', async () => {
    const fetcher = fetchResponses(
      page([FIRST], 'next-page', 2, 246),
      page([SECOND], null, 2, 246),
      page([SECOND]),
    );
    const { result } = renderHook(() => useSessionTracks('session-1'));
    await waitFor(() => expect(result.current.data?.items).toEqual([FIRST]));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(fetcher.mock.calls[1]![0]).toContain('cursor=next-page');
    expect(result.current.data?.items).toEqual([FIRST, SECOND]);
    expect(result.current.data?.totalDurationSeconds).toBe(246);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.data?.items).toEqual([SECOND]);
    expect(result.current.data?.total).toBe(1);
    expect(result.current.data?.totalDurationSeconds).toBe(123);
    expect(result.current.data?.genreTags).toEqual(['ambient']);
  });

  it('keeps loaded rows on a failed refresh and lets Retry recover', async () => {
    fetchResponses(
      page(),
      { ok: false, error: { code: 'internal_error', message: 'Try again' } },
      page([SECOND]),
    );
    const { result } = renderHook(() => useSessionTracks('session-1'));
    await waitFor(() => expect(result.current.data?.items).toEqual([FIRST]));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeTruthy();
    expect(result.current.data?.items).toEqual([FIRST]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.data?.items).toEqual([SECOND]);
  });

  it('refreshes unavailable Tracks after an in-flight read finishes', async () => {
    let finishRead!: (value: { json: () => Promise<unknown> }) => void;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => page([FIRST]) })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      )
      .mockResolvedValueOnce({ json: async () => page([SECOND]) });
    vi.stubGlobal('fetch', fetcher);
    const { result } = renderHook(() => useSessionTracks('session-1'));
    await waitFor(() => expect(result.current.data?.items).toEqual([FIRST]));
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      await result.current.refresh();
      finishRead({ json: async () => page([FIRST]) });
    });
    await waitFor(() => expect(result.current.data?.items).toEqual([SECOND]));
    expect(result.current.data?.total).toBe(1);
  });
});
