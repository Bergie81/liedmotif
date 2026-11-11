'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ActiveSessionOverview, SessionListItem } from '@liedmotif/shared';
import { usePageEpoch } from '@/components/use-page-epoch';
import { useServerSeed } from '@/components/use-server-seed';
import { appendUniqueById } from '@/lib/append-unique';
import { listSessions, setSessionPinned } from '@/lib/api-client';

export interface ResumableSessionsState {
  items: SessionListItem[] | null;
  /** Pinned Stopped Sessions (newest pin first); empty unless `includePinned`,
   * which also keeps them out of `items`. */
  pinned: SessionListItem[];
  activeSession: ActiveSessionOverview | null;
  error: string | null;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
  removeItem: (id: string) => void;
  /** Patch a loaded row in place after a rename or a cover swap. */
  updateItem: (id: string, patch: Partial<Pick<SessionListItem, 'title' | 'coverImageId'>>) => void;
  /** Pin/unpin; resolves whether the server accepted it (else `error` says why). */
  setPinned: (id: string, pinned: boolean) => Promise<boolean>;
  setOperationError: (message: string | null) => void;
  retry: () => void;
}

export interface ResumableSessionsInitialData {
  items: SessionListItem[];
  activeSession: ActiveSessionOverview | null;
  nextCursor: string | null;
  pinned: SessionListItem[];
}

export function useResumableSessions({
  limit = 20,
  includeActive = false,
  includePinned = false,
  initial,
}: {
  limit?: number;
  includeActive?: boolean;
  /** Split pinned Sessions out of `items` into `pinned`. */
  includePinned?: boolean;
  /** Server-rendered first page: seeds the state and skips the mount fetch.
   * Resume and retry reloads always refetch over the API. */
  initial?: ResumableSessionsInitialData;
} = {}): ResumableSessionsState {
  const router = useRouter();
  const [items, setItems] = useState<SessionListItem[] | null>(initial?.items ?? null);
  const [pinned, setPinnedItems] = useState<SessionListItem[]>(initial?.pinned ?? []);
  const [activeSession, setActiveSession] = useState<ActiveSessionOverview | null>(
    initial?.activeSession ?? null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(initial?.nextCursor ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const consumeServerSeed = useServerSeed(initial != null);
  const { loadingMore, invalidate, beginFirstPage, beginNextPage, settle } = usePageEpoch();

  useEffect(() => {
    if (consumeServerSeed()) {
      invalidate();
      return;
    }
    // A first-page reload (resume, retry) supersedes any in-flight next page.
    const token = beginFirstPage();
    setError(null);
    void listSessions({ limit, includeActive, includePinned }).then((result) => {
      if (!settle(token, result.ok)) return;
      if (result.ok) {
        setItems(result.data.items);
        setPinnedItems(result.data.pinned);
        setActiveSession(result.data.activeSession);
        setNextCursor(result.data.nextCursor);
      } else setError(result.error.message);
    });
    return () => {
      invalidate();
    };
  }, [
    includeActive,
    includePinned,
    limit,
    reload,
    consumeServerSeed,
    invalidate,
    beginFirstPage,
    settle,
  ]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const token = beginNextPage();
    if (token === null) return;
    setError(null);
    const result = await listSessions({
      limit,
      includeActive,
      includePinned,
      cursor: nextCursor,
    });
    if (!settle(token)) return;
    if (result.ok) {
      // An activity-ordered keyset can hand back a session that moved while
      // paging — append id-unique so a row never renders twice.
      setItems((current) => appendUniqueById(current ?? [], result.data.items));
      setNextCursor(result.data.nextCursor);
    } else setError(result.error.message);
  }

  async function setPinned(id: string, next: boolean): Promise<boolean> {
    setError(null);
    const result = await setSessionPinned(id, next);
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    // Back would otherwise replay the pre-pin lists from the router cache.
    router.refresh();
    const session = [...(items ?? []), ...pinned].find((item) => item.id === id);
    if (!session) {
      // Reached through search from a page not loaded yet: only a reload can place it.
      setReload((value) => value + 1);
      return true;
    }
    const moved = { ...session, pinned: next };
    if (next) {
      setItems((current) => current?.filter((item) => item.id !== id) ?? null);
      setPinnedItems((current) => [moved, ...current.filter((item) => item.id !== id)]);
    } else {
      setPinnedItems((current) => current.filter((item) => item.id !== id));
      setItems((current) => insertByRecency(current ?? [], moved, nextCursor !== null));
    }
    return true;
  }

  return {
    items,
    pinned,
    activeSession,
    error,
    nextCursor,
    loadingMore,
    loadMore,
    removeItem: (id) => {
      setItems((current) => current?.filter((item) => item.id !== id) ?? null);
      setPinnedItems((current) => current.filter((item) => item.id !== id));
    },
    updateItem: (id, patch) => {
      const update = (item: SessionListItem) => (item.id === id ? { ...item, ...patch } : item);
      setItems((current) => current?.map(update) ?? null);
      setPinnedItems((current) => current.map(update));
    },
    setPinned,
    setOperationError: setError,
    retry: () => setReload((value) => value + 1),
  };
}

/**
 * Place a Session back into the recency-ordered list (newest first). One older
 * than every loaded row belongs to a page not fetched yet, which delivers it in
 * its true position.
 */
function insertByRecency(
  items: SessionListItem[],
  session: SessionListItem,
  morePages: boolean,
): SessionListItem[] {
  const rest = items.filter((item) => item.id !== session.id);
  const index = rest.findIndex((item) => item.lastActiveAt < session.lastActiveAt);
  if (index === -1) return morePages ? rest : [...rest, session];
  return [...rest.slice(0, index), session, ...rest.slice(index)];
}
