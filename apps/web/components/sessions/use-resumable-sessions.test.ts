// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '@liedmotif/shared';
import { useResumableSessions } from './use-resumable-sessions';

vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({ engage: vi.fn(), beginOtherMusic: async () => true }),
}));
vi.mock('@/lib/use-client-id', () => ({
  useClientId: () => 'client-1',
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

interface PendingRequest {
  path: string;
  respond(body: unknown): void;
}

function sessionItem(id: string): SessionListItem {
  return {
    id,
    title: 'Morning focus',
    coverImageId: null,
    lastActiveAt: '2026-07-30T10:00:00.000Z',
    status: 'stopped',
    trackCount: 4,
    totalDurationSeconds: 720,
    genreTags: ['ambient'],
    pinned: false,
  };
}

function sessionsPage(items: SessionListItem[], nextCursor: string | null) {
  return { ok: true, data: { items, nextCursor, activeSession: null, pinned: [] } };
}

function captureFetches(): PendingRequest[] {
  const requests: PendingRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (path: string) =>
        new Promise((resolve) => {
          requests.push({ path, respond: (body) => resolve({ json: async () => body }) });
        }),
    ),
  );
  return requests;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

const FIRST = sessionItem('00000000-0000-4000-8000-000000000001');
const SECOND = sessionItem('00000000-0000-4000-8000-000000000002');

describe('useResumableSessions paging', () => {
  it('loads the next page with the cursor and appends it', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() =>
      useResumableSessions({
        includeActive: true,
        initial: { items: [FIRST], activeSession: null, nextCursor: 'page-2', pinned: [] },
      }),
    );

    expect(result.current.nextCursor).toBe('page-2');
    act(() => {
      void result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.path).toContain('cursor=page-2');

    await act(async () => requests[0]!.respond(sessionsPage([SECOND], null)));
    expect(result.current.items?.map((item) => item.id)).toEqual([FIRST.id, SECOND.id]);
    expect(result.current.nextCursor).toBeNull();
    expect(result.current.loadingMore).toBe(false);
  });

  it('dedupes a session that moved into the next page and resets paging on reload', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() =>
      useResumableSessions({
        includeActive: true,
        initial: { items: [FIRST], activeSession: null, nextCursor: 'page-2', pinned: [] },
      }),
    );

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.respond(sessionsPage([FIRST, SECOND], 'page-3')));
    expect(result.current.items?.map((item) => item.id)).toEqual([FIRST.id, SECOND.id]);

    act(() => result.current.retry());
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => requests[1]!.respond(sessionsPage([SECOND], null)));
    expect(result.current.items?.map((item) => item.id)).toEqual([SECOND.id]);
    expect(result.current.nextCursor).toBeNull();
  });

  it('never pages a reload with the cursor of the list it replaces', async () => {
    const requests = captureFetches();
    const THIRD = sessionItem('00000000-0000-4000-8000-000000000003');
    const { result } = renderHook(() =>
      useResumableSessions({
        includeActive: true,
        initial: { items: [FIRST, SECOND], activeSession: null, nextCursor: 'page-2', pinned: [] },
      }),
    );

    act(() => result.current.retry());
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => {
      void result.current.loadMore();
    });
    expect(requests).toHaveLength(1);

    await act(async () => requests[0]!.respond(sessionsPage([THIRD, FIRST], 'after-first')));
    expect(result.current.items?.map((item) => item.id)).toEqual([THIRD.id, FIRST.id]);
    expect(result.current.nextCursor).toBe('after-first');
  });
});

describe('useResumableSessions pinning', () => {
  it('flips the pinned flag once the server accepts the pin and drops the stale Back cache', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() =>
      useResumableSessions({
        initial: { items: [FIRST], activeSession: null, nextCursor: null, pinned: [] },
      }),
    );

    let accepted: Promise<boolean> | undefined;
    act(() => {
      accepted = result.current.setPinned(FIRST.id, true);
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.path).toBe('/api/sessions/pin');
    await act(async () => requests[0]!.respond({ ok: true, data: { id: FIRST.id, pinned: true } }));

    expect(await accepted).toBe(true);
    expect(result.current.items).toEqual([]);
    expect(result.current.pinned).toEqual([{ ...FIRST, pinned: true }]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('moves an unpinned Session back into the list by recency', async () => {
    const requests = captureFetches();
    const older = { ...SECOND, lastActiveAt: '2026-07-29T10:00:00.000Z' };
    const pinnedNewest = { ...sessionItem('00000000-0000-4000-8000-000000000003'), pinned: true };
    const { result } = renderHook(() =>
      useResumableSessions({
        initial: { items: [older], activeSession: null, nextCursor: null, pinned: [pinnedNewest] },
      }),
    );

    act(() => {
      void result.current.setPinned(pinnedNewest.id, false);
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () =>
      requests[0]!.respond({ ok: true, data: { id: pinnedNewest.id, pinned: false } }),
    );

    expect(result.current.pinned).toEqual([]);
    expect(result.current.items?.map((item) => item.id)).toEqual([pinnedNewest.id, older.id]);
    expect(result.current.items?.[0]?.pinned).toBe(false);
  });

  it('keeps the flag and surfaces the message when the pin limit is reached', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() =>
      useResumableSessions({
        initial: { items: [FIRST], activeSession: null, nextCursor: null, pinned: [] },
      }),
    );

    let accepted: Promise<boolean> | undefined;
    act(() => {
      accepted = result.current.setPinned(FIRST.id, true);
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () =>
      requests[0]!.respond({
        ok: false,
        error: {
          code: 'limit_reached',
          message: 'You can pin up to 10 Sessions.',
          retryable: false,
        },
      }),
    );

    expect(await accepted).toBe(false);
    expect(result.current.items).toEqual([FIRST]);
    expect(result.current.pinned).toEqual([]);
    expect(result.current.error).toBe('You can pin up to 10 Sessions.');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('keeps pinned Sessions out of later pages', async () => {
    const requests = captureFetches();
    const { result } = renderHook(() =>
      useResumableSessions({
        includePinned: true,
        initial: { items: [FIRST], activeSession: null, nextCursor: 'page-2', pinned: [] },
      }),
    );

    act(() => {
      void result.current.loadMore();
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.path).toContain('includePinned=true');
  });

  it('leaves an unpinned Session older than every loaded row to its own page', async () => {
    const requests = captureFetches();
    const oldPinned = {
      ...sessionItem('00000000-0000-4000-8000-000000000003'),
      lastActiveAt: '2026-01-01T10:00:00.000Z',
      pinned: true,
    };
    const { result } = renderHook(() =>
      useResumableSessions({
        initial: { items: [FIRST], activeSession: null, nextCursor: 'page-2', pinned: [oldPinned] },
      }),
    );

    act(() => {
      void result.current.setPinned(oldPinned.id, false);
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () =>
      requests[0]!.respond({ ok: true, data: { id: oldPinned.id, pinned: false } }),
    );

    expect(result.current.pinned).toEqual([]);
    expect(result.current.items).toEqual([FIRST]);
  });
});
