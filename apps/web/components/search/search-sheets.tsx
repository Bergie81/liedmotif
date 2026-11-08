'use client';

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { SEARCH_SORTS } from '@liedmotif/shared';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTrigger } from '@/components/ui/sheet';
import { SEARCH_SORT_LABELS, type SearchSort } from './search-model';

export function SearchSortSheet({
  sort,
  onSortChange,
  children,
}: {
  sort: SearchSort;
  onSortChange: (sort: SearchSort) => void;
  children: ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader title="Sort results" />
        <fieldset className="my-5 border-y border-line">
          <legend className="sr-only">Sort search results</legend>
          {SEARCH_SORTS.map((option) => {
            const selected = sort === option;
            return (
              <label
                key={option}
                className="flex w-full cursor-pointer items-center gap-3 border-b border-line py-3 text-left text-[14.5px] last:border-b-0 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-lamp"
              >
                <input
                  type="radio"
                  name="search-sort"
                  value={option}
                  checked={selected}
                  onChange={() => onSortChange(option)}
                  className="sr-only"
                />
                <span
                  className={cn(
                    'grid h-5 w-5 place-items-center rounded-full border border-line-2',
                    selected && 'border-lamp bg-lamp text-night',
                  )}
                >
                  {selected ? <Check className="h-3 w-3" /> : null}
                </span>
                {SEARCH_SORT_LABELS[option]}
              </label>
            );
          })}
        </fieldset>
        <SheetClose className={cn(secondaryButtonClass, 'w-full')}>Done</SheetClose>
      </SheetContent>
    </Sheet>
  );
}
