// The search page's client state and its URL mapping. State is URL-backed
// (?q=, ?scope=, ?sort=, ?lyrics=1) so a reload reproduces the results and a
// search can be linked; the reducer holds the COMMITTED query (debounced or
// Enter-flushed), never raw keystrokes.

import {
  SEARCH_SCOPED_GROUP_LIMIT,
  SEARCH_SCOPES,
  SEARCH_SORTS,
  type SearchScope,
  type SearchSort,
} from '@liedmotif/shared';

export type { SearchScope, SearchSort } from '@liedmotif/shared';

/** Below this, nothing runs and the resting state stays. */
export const MIN_SEARCH_QUERY_LENGTH = 2;

export const SEARCH_GROUPS = ['sessions', 'tracks', 'playlists'] as const;
export type SearchGroupKind = (typeof SEARCH_GROUPS)[number];

export const SEARCH_GROUP_LABELS: Record<SearchGroupKind, string> = {
  sessions: 'Sessions',
  tracks: 'Tracks',
  playlists: 'Playlists',
};

export const SEARCH_SORT_LABELS: Record<SearchSort, string> = {
  relevance: 'Relevance',
  newest: 'Newest First',
  title: 'Title A–Z',
};

export function isSearchScope(value: string): value is SearchScope {
  return (SEARCH_SCOPES as readonly string[]).includes(value);
}

export function isSearchSort(value: string): value is SearchSort {
  return (SEARCH_SORTS as readonly string[]).includes(value);
}

export interface SearchState {
  query: string;
  scope: SearchScope;
  sort: SearchSort;
  /** Lyrics mode: exclusive lens over sung lyric text, Tracks only. */
  lyrics: boolean;
}

export type SearchAction =
  | { type: 'queryChanged'; query: string }
  | { type: 'queryCleared' }
  | { type: 'scopeChanged'; scope: SearchScope }
  | { type: 'sortChanged'; sort: SearchSort }
  | { type: 'lyricsToggled' }
  /** A Recent chip restores both the words and the lens they were typed through. */
  | { type: 'searchRestored'; query: string; lyrics: boolean };

export function createInitialSearchState(): SearchState {
  return { query: '', scope: 'all', sort: 'relevance', lyrics: false };
}

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case 'queryChanged':
      return { ...state, query: action.query };
    case 'queryCleared':
      return createInitialSearchState();
    case 'scopeChanged':
      return { ...state, scope: action.scope };
    case 'sortChanged':
      return { ...state, sort: action.sort };
    case 'lyricsToggled':
      // The lens changed, not the words: scope collapses with the lyrics
      // toggle in BOTH directions, so no stale tab survives the switch.
      return { ...state, lyrics: !state.lyrics, scope: 'all' };
    case 'searchRestored':
      return { ...createInitialSearchState(), query: action.query, lyrics: action.lyrics };
  }
}

/** The runnable query: trimmed, or null under the minimum length (resting). */
export function effectiveSearchQuery(state: SearchState): string | null {
  const query = state.query.trim();
  return query.length >= MIN_SEARCH_QUERY_LENGTH ? query : null;
}

/** Initial state from the page's `searchParams` (unvalidated URL values). */
export function searchStateFromParams(
  params: Partial<Record<'q' | 'scope' | 'sort' | 'lyrics', string | string[] | undefined>>,
): SearchState {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const q = first(params.q);
  const scope = first(params.scope);
  const sort = first(params.sort);
  const lyricsParam = first(params.lyrics);
  const lyrics = lyricsParam === '1' || lyricsParam === 'true';
  return {
    query: q ?? '',
    // Lyrics mode has no scope tabs, so a scope param under it is ignored.
    scope: !lyrics && scope && isSearchScope(scope) ? scope : 'all',
    sort: sort && isSearchSort(sort) ? sort : 'relevance',
    lyrics,
  };
}

/**
 * The `?q=…` query string for the address bar and `/api/search`, defaults
 * omitted so a plain search stays a plain URL. Empty when there is nothing
 * to carry.
 */
export function searchQueryString(state: SearchState): string {
  const params = new URLSearchParams();
  const query = state.query.trim();
  if (query) params.set('q', query);
  if (!state.lyrics && state.scope !== 'all') params.set('scope', state.scope);
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.lyrics) params.set('lyrics', '1');
  return params.toString();
}

/**
 * How a capped group states its truncation (ADR 0015: never silent). Under
 * All a group's own tab widens the list, so the line gives both numbers and
 * leads there; a single-group view (a scope tab, the lyrics lens) has no
 * wider list, so it asks for a narrower search instead.
 */
export type SearchTruncationNote =
  | { view: 'all'; shown: string; action: string; scope: SearchGroupKind }
  | { view: 'single'; text: string };

export function searchTruncationNote(
  view: { scope: SearchScope; lyrics: boolean },
  kind: SearchGroupKind,
  group: { shown: number; matchCount: number; truncated: boolean },
): SearchTruncationNote | null {
  if (!group.truncated) return null;
  if (view.scope === 'all' && !view.lyrics) {
    return {
      view: 'all',
      shown: `${group.shown} of ${group.matchCount}`,
      action: `Show ${SEARCH_GROUP_LABELS[kind]}`,
      scope: kind,
    };
  }
  return {
    view: 'single',
    text: `Showing the ${SEARCH_SCOPED_GROUP_LIMIT} best matches — narrow your search.`,
  };
}
