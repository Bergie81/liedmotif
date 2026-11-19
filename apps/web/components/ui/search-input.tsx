'use client';

import type { ComponentProps } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The one search box every surface wears — Search, Library tabs, the Lounge —
 * so a query field looks and behaves the same wherever it is met. Purely
 * presentational: the caller owns the value, the debounce, and what Clear does.
 */
export function SearchInput({
  value,
  onValueChange,
  onClear,
  width = 'page',
  className,
  ...inputProps
}: {
  value: string;
  onValueChange: (value: string) => void;
  onClear: () => void;
  /** `page` sizes the box for a page's top bar; `fill` takes the container's width (a sheet). */
  width?: 'page' | 'fill';
  className?: string;
} & Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange' | 'className'>) {
  return (
    <div
      className={cn(
        'relative',
        width === 'page' ? 'max-w-[560px] desk:w-1/2 desk:max-w-none' : 'w-full',
        className,
      )}
    >
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-dim"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className="h-12 w-full rounded-full border border-line-2 bg-[var(--field-bg)] shadow-[var(--shadow-field)] light:focus:bg-panel pl-11 pr-12 text-[15px] text-paper outline-none placeholder:text-dim focus:border-lamp/60 focus:shadow-[0_0_0_3px_var(--focus-ring)] [&::-webkit-search-cancel-button]:hidden"
        {...inputProps}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted transition hover:text-paper"
          onClick={onClear}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
