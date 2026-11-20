'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { Clock3, MicVocal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { chipClass } from '@/components/ui/design-system';
import { createSearchDebouncer, type SearchDebouncer } from '@/components/library/search-debounce';
import { MAX_SEARCH_QUERY_LENGTH } from '@liedmotif/shared';
import { readRecentSearches, recordRecentSearch, type RecentSearch } from './recent-searches';
import {
  effectiveSearchQuery,
  MIN_SEARCH_QUERY_LENGTH,
  searchQueryString,
  searchReducer,
  type SearchState,
} from './search-model';
import { SearchInput } from '@/components/ui/search-input';
import { SearchResults } from './search-results';
import { useSearchQuery } from './use-search-query';

/** The lyrics toggle and every Recent chip are the same chip with an icon. */
const searchChipClass = cn(chipClass, 'inline-flex items-center gap-2');

export function SearchView({
  initialState,
  userId,
}: {
  initialState: SearchState;
  userId: string;
}) {
  const [state, dispatch] = useReducer(searchReducer, initialState);
  // The field holds raw keystrokes; the reducer holds the committed query
  // (debounced through the app's one search timing model, or Enter-flushed).
  const [input, setInput] = useState(initialState.query);
  // A Track deleted from a row changes the exact counts the page states.
  const [revision, setRevision] = useState(0);
  const results = useSearchQuery(state, revision);

  // Recents hydrate after mount: localStorage does not exist on the server.
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  useEffect(() => {
    setRecents(readRecentSearches(userId));
  }, [userId]);

  // `dispatch` is referentially stable, so the debouncer can close over it.
  const debouncerRef = useRef<SearchDebouncer | null>(null);
  debouncerRef.current ??= createSearchDebouncer((query) =>
    dispatch({ type: 'queryChanged', query }),
  );
  const debouncer = debouncerRef.current;
  useEffect(() => () => debouncerRef.current?.cancel(), []);

  // URL-backed state, written with replaceState while typing: the back button
  // leaves /search instead of stepping through keystrokes, and a reload
  // reproduces the results.
  useEffect(() => {
    const query = searchQueryString(state);
    window.history.replaceState(null, '', query ? `/search?${query}` : '/search');
  }, [state]);

  // Engagement — Enter, or acting on a result — is the only thing that writes
  // a Recent, always under the lens the search ran through.
  function recordSearch(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) return;
    setRecents(recordRecentSearch(userId, { query: trimmed, lyrics: state.lyrics }));
  }

  function flushQuery() {
    debouncer.sync(input);
    dispatch({ type: 'queryChanged', query: input.trim() });
  }

  function clearQuery() {
    debouncer.sync('');
    setInput('');
    dispatch({ type: 'queryCleared' });
  }

  const resting = effectiveSearchQuery(state) === null;

  return (
    <>
      <div role="search" className="mb-3 mt-5">
        <SearchInput
          value={input}
          onValueChange={(value) => {
            setInput(value);
            debouncer.input(value);
          }}
          onClear={clearQuery}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            flushQuery();
            recordSearch(input);
          }}
          aria-label="Search sessions, tracks and playlists"
          placeholder="Search titles, prompts, genres or moods…"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={MAX_SEARCH_QUERY_LENGTH}
        />
      </div>

      <div className="mb-3 max-w-[760px]">
        <button
          type="button"
          aria-pressed={state.lyrics}
          onClick={() => {
            // The lens changed, not the words: any pending keystrokes commit
            // now and the search re-runs immediately, no debounce wait.
            flushQuery();
            dispatch({ type: 'lyricsToggled' });
          }}
          className={searchChipClass}
        >
          <MicVocal className="h-3.5 w-3.5" aria-hidden /> Search Lyrics
        </button>
      </div>

      {resting ? (
        <SearchRestingState
          recents={recents}
          onPick={(recent) => {
            debouncer.sync(recent.query);
            setInput(recent.query);
            dispatch({ type: 'searchRestored', query: recent.query, lyrics: recent.lyrics });
          }}
        />
      ) : (
        <SearchResults
          state={state}
          results={results}
          onScopeChange={(scope) => dispatch({ type: 'scopeChanged', scope })}
          onSortChange={(sort) => dispatch({ type: 'sortChanged', sort })}
          onEngage={() => recordSearch(state.query)}
          onTrackRemoved={() => setRevision((current) => current + 1)}
        />
      )}
    </>
  );
}

/** The resting state shows Recent and nothing else. */
function SearchRestingState({
  recents,
  onPick,
}: {
  recents: RecentSearch[];
  onPick: (recent: RecentSearch) => void;
}) {
  if (recents.length === 0) return null;
  return (
    <div className="max-w-[760px]">
      <h2 className="mb-3 mt-6 font-display text-[17px] font-bold">Recent</h2>
      <div className="flex flex-wrap gap-2">
        {recents.map((recent) => (
          <button
            key={`${recent.lyrics ? 'lyrics' : 'text'}:${recent.query.toLowerCase()}`}
            type="button"
            onClick={() => onPick(recent)}
            className={searchChipClass}
          >
            <Clock3 className="h-3.5 w-3.5 text-dim" aria-hidden />
            {recent.query}
            {recent.lyrics ? (
              <MicVocal className="h-3.5 w-3.5 text-lamp" aria-label="Lyrics search" />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
