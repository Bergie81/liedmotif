import { describe, expect, it } from 'vitest';
import {
  createInitialSearchState,
  effectiveSearchQuery,
  isSearchScope,
  isSearchSort,
  searchQueryString,
  searchReducer,
  searchStateFromParams,
  type SearchState,
} from './search-model';

function state(overrides: Partial<SearchState> = {}): SearchState {
  return { ...createInitialSearchState(), ...overrides };
}

describe('searchReducer', () => {
  it('commits a query and clears back to the initial state', () => {
    const typed = searchReducer(state(), { type: 'queryChanged', query: 'rainy run' });
    expect(typed.query).toBe('rainy run');
    expect(
      searchReducer({ ...typed, scope: 'tracks', lyrics: true }, { type: 'queryCleared' }),
    ).toEqual(createInitialSearchState());
  });

  it('changes scope and sort independently', () => {
    const scoped = searchReducer(state(), { type: 'scopeChanged', scope: 'playlists' });
    expect(scoped.scope).toBe('playlists');
    expect(searchReducer(scoped, { type: 'sortChanged', sort: 'title' }).sort).toBe('title');
  });

  it('collapses the scope when the lyrics lens toggles in either direction', () => {
    const on = searchReducer(state({ scope: 'sessions' }), { type: 'lyricsToggled' });
    expect(on).toMatchObject({ lyrics: true, scope: 'all' });
    const off = searchReducer({ ...on, scope: 'tracks' }, { type: 'lyricsToggled' });
    expect(off).toMatchObject({ lyrics: false, scope: 'all' });
  });

  it('restores a recent search with its lens, resetting scope and sort', () => {
    const restored = searchReducer(state({ scope: 'playlists', sort: 'title' }), {
      type: 'searchRestored',
      query: 'chorus line',
      lyrics: true,
    });
    expect(restored).toEqual({
      query: 'chorus line',
      scope: 'all',
      sort: 'relevance',
      lyrics: true,
    });
  });
});

describe('effectiveSearchQuery — the minimum-length rule', () => {
  it('returns null below two characters and the trimmed query at two or more', () => {
    expect(effectiveSearchQuery(state({ query: '' }))).toBeNull();
    expect(effectiveSearchQuery(state({ query: 'x' }))).toBeNull();
    expect(effectiveSearchQuery(state({ query: '  x  ' }))).toBeNull();
    expect(effectiveSearchQuery(state({ query: ' xy ' }))).toBe('xy');
  });
});

describe('URL round-trip', () => {
  it('omits defaults and carries every non-default piece of state', () => {
    expect(searchQueryString(state())).toBe('');
    expect(searchQueryString(state({ query: 'rainy run', scope: 'tracks', sort: 'newest' }))).toBe(
      'q=rainy+run&scope=tracks&sort=newest',
    );
    expect(searchQueryString(state({ query: 'chorus', lyrics: true, scope: 'tracks' }))).toBe(
      'q=chorus&lyrics=1',
    );
  });

  it('reproduces the state from its own query string', () => {
    for (const original of [
      state({ query: 'rainy run', scope: 'tracks', sort: 'newest' }),
      state({ query: 'chorus line', lyrics: true }),
      state(),
    ]) {
      const params = Object.fromEntries(new URLSearchParams(searchQueryString(original)));
      expect(searchStateFromParams(params)).toEqual(original);
    }
  });

  it('ignores unknown scope and sort values and a scope under the lyrics lens', () => {
    expect(searchStateFromParams({ q: 'ab', scope: 'albums', sort: 'oldest' })).toEqual(
      state({ query: 'ab' }),
    );
    expect(searchStateFromParams({ q: 'ab', scope: 'sessions', lyrics: '1' })).toEqual(
      state({ query: 'ab', lyrics: true }),
    );
  });
});

describe('vocabulary guards', () => {
  it('accepts exactly the known scopes and sorts', () => {
    expect(isSearchScope('all')).toBe(true);
    expect(isSearchScope('tracks')).toBe(true);
    expect(isSearchScope('albums')).toBe(false);
    expect(isSearchSort('relevance')).toBe(true);
    expect(isSearchSort('oldest')).toBe(false);
  });
});
