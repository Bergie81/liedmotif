'use client';

// The one concurrency rule every cursor-paged list obeys: a response may only
// land while the epoch it was fetched under is still current. Opening a new
// epoch (first-page load, query change, reset, unmount) makes every in-flight
// fetch from before settle as stale — so a superseded page can never overwrite
// or append onto a fresher list. A next page joins an epoch only once its first
// page has landed: until then the only cursor in hand belongs to the list being
// replaced, and paging the new query with it would skip rows.

import { useCallback, useRef, useState } from 'react';

export interface PageEpoch {
  /** A next-page fetch is in flight in the current epoch (the Load more busy state). */
  loadingMore: boolean;
  /** Open a new epoch and return its token: every earlier fetch now settles stale. */
  invalidate: () => number;
  /** Open a new epoch for a first-page fetch; no next page joins it until that page settles. */
  beginFirstPage: () => number;
  /** Mark a next-page fetch in flight; returns the token to settle with, or null
   *  while the epoch's first page is still out. */
  beginNextPage: () => number | null;
  /** True iff the token's epoch is still current; clears the busy flag when it is.
   *  A first page settled with `landed: false` (it failed) keeps next pages out:
   *  the only cursor in hand still belongs to the list being replaced. */
  settle: (token: number, landed?: boolean) => boolean;
}

export function usePageEpoch(): PageEpoch {
  const epoch = useRef(0);
  const firstPageEpoch = useRef<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const invalidate = useCallback(() => {
    epoch.current += 1;
    setLoadingMore(false);
    return epoch.current;
  }, []);

  const beginFirstPage = useCallback(() => {
    const token = invalidate();
    firstPageEpoch.current = token;
    return token;
  }, [invalidate]);

  const beginNextPage = useCallback(() => {
    if (firstPageEpoch.current === epoch.current) return null;
    setLoadingMore(true);
    return epoch.current;
  }, []);

  const settle = useCallback((token: number, landed = true) => {
    if (token !== epoch.current) return false;
    if (landed) firstPageEpoch.current = null;
    setLoadingMore(false);
    return true;
  }, []);

  return { loadingMore, invalidate, beginFirstPage, beginNextPage, settle };
}
