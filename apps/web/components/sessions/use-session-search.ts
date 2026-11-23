'use client';

import { useEffect, useState } from 'react';
import type { SearchSessionItem, SessionListItem } from '@liedmotif/shared';
import { effectiveSearchQuery, type SearchState } from '@/components/search/search-model';
import { useSearchQuery } from '@/components/search/use-search-query';

export type SessionSearch = ReturnType<typeof useSessionSearch>;

/**
 * The My Sessions box: the one Search retrieval, scoped to Sessions.
 * Acts on a result settle after the response rendered, so the rows live in a
 * local copy they can patch; a new response replaces it.
 */
export function useSessionSearch(query: string) {
  const state: SearchState = { query, scope: 'sessions', sort: 'relevance', lyrics: false };
  const [revision, setRevision] = useState(0);
  const { data, error } = useSearchQuery(state, revision);
  const [results, setResults] = useState<SearchSessionItem[] | null>(null);
  useEffect(() => setResults(data?.sessions?.items ?? null), [data]);
  return {
    searching: effectiveSearchQuery(state) !== null,
    results: error ? null : results,
    /** The words `results` answer, which trail `query` while a newer one is in flight. */
    resultsQuery: data?.query ?? query,
    /** The results are the closest names, because no Session matched the words exactly. */
    closeMatches: data?.closeMatches ?? false,
    truncated: data?.sessions?.truncated ?? false,
    matchCount: data?.sessions?.matchCount ?? 0,
    error,
    patchResult: (id: string, patch: Partial<SessionListItem>) =>
      setResults(
        (rows) => rows?.map((row) => (row.id === id ? { ...row, ...patch } : row)) ?? null,
      ),
    /** Hides the row now; the re-read restores the exact count and any match the cap held back. */
    removeResult: (id: string) => {
      setResults((rows) => rows?.filter((row) => row.id !== id) ?? null);
      setRevision((value) => value + 1);
    },
  };
}
