'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionTracksData } from '@liedmotif/shared';
import { listSessionTracks } from '@/lib/http/api-client';

/** Mounted only while the sheet is open; browsing never wakes generation. */
export function useSessionTracks(sessionId: string) {
  const [data, setData] = useState<SessionTracksData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const state = useRef({ data: null as SessionTracksData | null, pages: 1 });
  const request = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);

  const read = useCallback(
    async function read(more: boolean): Promise<void> {
      if (request.current) {
        if (!more) refreshPending.current = true;
        return;
      }
      const previous = state.current;
      if (more && previous.data?.nextCursor == null) return;
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      // Loading more appends the next page; a refresh re-reads every loaded page.
      const targetPages = more ? previous.pages + 1 : previous.pages;
      let cursor = more ? previous.data!.nextCursor : null;
      let items = more ? previous.data!.items : [];
      let pages = more ? previous.pages : 0;
      try {
        let latest: SessionTracksData;
        do {
          const result = await listSessionTracks(sessionId, cursor, controller.signal);
          if (controller.signal.aborted) return;
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          latest = result.data;
          items = [...items, ...latest.items];
          cursor = latest.nextCursor;
          pages++;
        } while (cursor !== null && pages < targetPages);
        const next = {
          ...latest,
          items: [...new Map(items.map((item) => [item.id, item])).values()],
        };
        state.current = { data: next, pages };
        setData(next);
        setError(null);
      } finally {
        if (request.current === controller) {
          request.current = null;
          if (!controller.signal.aborted) {
            if (refreshPending.current) {
              refreshPending.current = false;
              void read(false);
            } else {
              setLoading(false);
            }
          }
        }
      }
    },
    [sessionId],
  );

  const refresh = useCallback(() => read(false), [read]);
  const loadMore = useCallback(() => read(true), [read]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 10_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      request.current?.abort();
      request.current = null;
      refreshPending.current = false;
    };
  }, [refresh]);

  return { data, error, loading, refresh, loadMore };
}
