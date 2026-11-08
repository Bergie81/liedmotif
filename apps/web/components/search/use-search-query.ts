'use client';

// Runs the search whenever the committed state changes and keeps the previous
// results on screen while a newer query is in flight. Stale responses are
// discarded by sequence token — the last thing typed always wins, regardless
// of response order.

import { useEffect, useRef, useState } from 'react';
import type { SearchResponseData } from '@liedmotif/shared';
import { search } from '@/lib/api-client';
import { effectiveSearchQuery, type SearchGroupKind, type SearchState } from './search-model';

export type SearchGroupCounts = Record<SearchGroupKind, number | null>;

export interface SearchQueryState {
  /** Latest settled results; null before the first response (or at rest). */
  data: SearchResponseData | null;
  loading: boolean;
  error: string | null;
  /**
   * Last-known exact count per group for the CURRENT query. A scoped request
   * counts only its own group, so the others keep what an earlier scope
   * reported (null = never counted — the tab badge stays hidden).
   */
  counts: SearchGroupCounts;
}

const UNKNOWN_COUNTS: SearchGroupCounts = { sessions: null, tracks: null, playlists: null };

/** `revision`: bump it to re-read the same search once its matches have changed. */
export function useSearchQuery(state: SearchState, revision = 0): SearchQueryState {
  const [data, setData] = useState<SearchResponseData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<SearchGroupCounts>(UNKNOWN_COUNTS);
  const seqRef = useRef(0);

  const query = effectiveSearchQuery(state);
  const { scope, sort, lyrics } = state;

  // The words or the lens changed: every remembered count is for a different
  // search now. (A scope or sort change keeps them — counts are scope-free.)
  useEffect(() => {
    setCounts(UNKNOWN_COUNTS);
  }, [query, lyrics]);

  useEffect(() => {
    const seq = ++seqRef.current;
    if (!query) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    // Abort the superseded request instead of downloading and parsing a payload
    // the sequence token would discard anyway; the token stays as the
    // correctness backstop against out-of-order settles.
    const controller = new AbortController();
    void search({ q: query, scope, sort, lyrics }, controller.signal).then((result) => {
      if (controller.signal.aborted || seq !== seqRef.current) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setData(result.data);
      setCounts((current) => ({
        sessions: result.data.sessions?.matchCount ?? current.sessions,
        tracks: result.data.tracks?.matchCount ?? current.tracks,
        playlists: result.data.playlists?.matchCount ?? current.playlists,
      }));
    });
    return () => controller.abort();
  }, [query, scope, sort, lyrics, revision]);

  return { data, loading, error, counts };
}
