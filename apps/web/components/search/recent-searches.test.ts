// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRecentSearch,
  MAX_RECENT_SEARCHES,
  parseRecentSearches,
  readRecentSearches,
  recordRecentSearch,
  type RecentSearch,
} from './recent-searches';

function entry(query: string, lyrics = false): RecentSearch {
  return { query, lyrics };
}

describe('addRecentSearch', () => {
  it('prepends most-recent-first and caps at the maximum', () => {
    let list: RecentSearch[] = [];
    for (let i = 0; i < MAX_RECENT_SEARCHES + 1; i += 1) {
      list = addRecentSearch(list, entry(`query ${i}`));
    }
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    expect(list[0]!.query).toBe(`query ${MAX_RECENT_SEARCHES}`);
    // The 7th distinct search evicted the oldest.
    expect(list.some((item) => item.query === 'query 0')).toBe(false);
  });

  it('dedupes case-insensitively by moving the entry to the front', () => {
    let list = [entry('rainy run'), entry('focus')];
    list = addRecentSearch(list, entry('Focus'));
    expect(list.map((item) => item.query)).toEqual(['Focus', 'rainy run']);
  });

  it('carries the lyrics lens and lets a repeat change it', () => {
    let list = addRecentSearch([], entry('chorus line', true));
    expect(list[0]).toEqual({ query: 'chorus line', lyrics: true });
    list = addRecentSearch(list, entry('chorus line', false));
    expect(list).toEqual([{ query: 'chorus line', lyrics: false }]);
  });

  it('ignores queries below the minimum length', () => {
    expect(addRecentSearch([], entry(' x '))).toEqual([]);
  });
});

describe('parseRecentSearches — corrupt-input tolerance', () => {
  it('degrades every malformed shape to a clean list', () => {
    expect(parseRecentSearches(null)).toEqual([]);
    expect(parseRecentSearches('not json {')).toEqual([]);
    expect(parseRecentSearches('"a string"')).toEqual([]);
    expect(parseRecentSearches('{"query":"solo"}')).toEqual([]);
    expect(
      parseRecentSearches(
        JSON.stringify([
          { query: 'kept', lyrics: false },
          { query: 42, lyrics: false },
          { lyrics: true },
          'loose string',
          { query: 'x', lyrics: true },
        ]),
      ),
    ).toEqual([{ query: 'kept', lyrics: false }]);
  });
});

describe('persistence round-trip', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('records, reads back, and keeps the lyrics flag', () => {
    recordRecentSearch('user-a', entry('rainy run'));
    recordRecentSearch('user-a', entry('chorus line', true));
    expect(readRecentSearches('user-a')).toEqual([
      { query: 'chorus line', lyrics: true },
      { query: 'rainy run', lyrics: false },
    ]);
  });

  it("keeps each account's recents to that account across sign-out and sign-in", () => {
    recordRecentSearch('user-a', entry('secret lyric line', true));
    expect(readRecentSearches('user-b')).toEqual([]);
    recordRecentSearch('user-b', entry('rainy run'));
    expect(readRecentSearches('user-a')).toEqual([{ query: 'secret lyric line', lyrics: true }]);
    expect(readRecentSearches('user-b')).toEqual([{ query: 'rainy run', lyrics: false }]);
  });

  it('never hands unscoped legacy history to whoever signs in next', () => {
    window.localStorage.setItem(
      'liedmotif-recent-searches',
      JSON.stringify([{ query: 'previous account query', lyrics: true }]),
    );
    expect(readRecentSearches('user-b')).toEqual([]);
    recordRecentSearch('user-b', entry('rainy run'));
    expect(readRecentSearches('user-b')).toEqual([{ query: 'rainy run', lyrics: false }]);
    expect(window.localStorage.getItem('liedmotif-recent-searches')).toBeNull();
  });
});
