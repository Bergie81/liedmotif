'use client';

import { useEffect, useRef, useState } from 'react';
import { SearchInput } from '@/components/ui/search-input';
import { createSearchDebouncer, type SearchDebouncer } from './search-debounce';

/**
 * The search input of a Library tab or My Sessions: debounced
 * (`SEARCH_DEBOUNCE_MS` of inactivity), trimmed, and silent when the query hasn't
 * changed. What a query matches is the list's business — the placeholder tells
 * the user.
 */
export function LibrarySearchField({
  placeholder,
  onSearch,
  width,
  className = 'mt-4',
}: {
  placeholder: string;
  onSearch: (query: string) => void;
  width?: 'page' | 'fill';
  className?: string;
}) {
  const [value, setValue] = useState('');
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const debouncerRef = useRef<SearchDebouncer | null>(null);
  debouncerRef.current ??= createSearchDebouncer((query) => onSearchRef.current(query));
  useEffect(() => () => debouncerRef.current?.cancel(), []);

  function update(raw: string) {
    setValue(raw);
    debouncerRef.current?.input(raw);
  }

  return (
    <SearchInput
      width={width}
      className={className}
      value={value}
      onValueChange={update}
      onClear={() => update('')}
      maxLength={200}
      data-testid="library-search"
      placeholder={placeholder}
      aria-label={placeholder}
    />
  );
}
