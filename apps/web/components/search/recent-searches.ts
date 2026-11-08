// Recent searches: local-only, written on ENGAGEMENT (Enter, or acting on a
// result) — never on typing, so the prefixes of one search cannot pile up as
// four entries. Each entry remembers the lens it was made through, so a
// remembered lyric search comes back as a lyric search.
//
// Storage is keyed by user id so accounts sharing a browser never see each
// other's queries, while each keeps its own across sign-out. The unscoped
// legacy key has no knowable owner, so it is dropped rather than shown.

import {
  readBrowserPreference,
  removeBrowserPreference,
  writeBrowserPreference,
} from '@/lib/browser-preferences';
import { MIN_SEARCH_QUERY_LENGTH } from './search-model';

const LEGACY_STORAGE_KEY = 'liedmotif-recent-searches';

function storageKey(userId: string): string {
  return `${LEGACY_STORAGE_KEY}:${userId}`;
}

export const MAX_RECENT_SEARCHES = 6;

export interface RecentSearch {
  query: string;
  lyrics: boolean;
}

function isRecentSearch(value: unknown): value is RecentSearch {
  const entry = value as Partial<RecentSearch> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.query === 'string' &&
    typeof entry.lyrics === 'boolean'
  );
}

/** Corrupt or unparsable stored data degrades to an empty list, never a broken page. */
export function parseRecentSearches(raw: string | null): RecentSearch[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentSearch)
      .map((entry) => ({ query: entry.query.trim(), lyrics: entry.lyrics }))
      .filter((entry) => entry.query.length >= MIN_SEARCH_QUERY_LENGTH)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

/**
 * Most-recent-first with case-insensitive dedupe: repeating a search moves the
 * existing entry to the front (carrying the newest lens) instead of adding a
 * second; a 7th distinct search evicts the oldest.
 */
export function addRecentSearch(list: RecentSearch[], entry: RecentSearch): RecentSearch[] {
  const query = entry.query.trim();
  if (query.length < MIN_SEARCH_QUERY_LENGTH) return list;
  const kept = list.filter((existing) => existing.query.toLowerCase() !== query.toLowerCase());
  return [{ query, lyrics: entry.lyrics }, ...kept].slice(0, MAX_RECENT_SEARCHES);
}

export function readRecentSearches(userId: string): RecentSearch[] {
  removeBrowserPreference(LEGACY_STORAGE_KEY);
  return parseRecentSearches(readBrowserPreference(storageKey(userId)));
}

/** Persistence failure leaves search fully usable — the write just doesn't stick. */
export function recordRecentSearch(userId: string, entry: RecentSearch): RecentSearch[] {
  const next = addRecentSearch(readRecentSearches(userId), entry);
  writeBrowserPreference(storageKey(userId), JSON.stringify(next));
  return next;
}
