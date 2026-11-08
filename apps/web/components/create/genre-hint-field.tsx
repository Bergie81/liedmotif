'use client';

import { cn } from '@/lib/cn';
import { chipClass } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTrigger } from '@/components/ui/sheet';
import {
  GENRE_FAMILIES,
  MAX_GENRES,
  buildGenreShortlist,
  genreLabel,
  toggleGenre,
} from './genre-vocabulary';

/** The genre field from the draft home design: a shortlist row (picks lead,
 * the User's For you genres follow, curated defaults fill the rest) with the
 * whole vocabulary one tap away in a bottom sheet, grouped the way a record
 * shop is. */
export function GenreHintField({
  selected,
  onChange,
  hint,
  forYouGenres = [],
  shortlist = 'suggested',
}: {
  selected: string[];
  onChange: (selected: string[]) => void;
  hint?: string;
  /** Learned-taste genres (ranked). A suggestion order only: picks and the full
   *  vocabulary are untouched by it. */
  forYouGenres?: readonly string[];
  /** `selected-only` renders just the current picks beside "+ All genres" —
   *  the Change Vibe overlay shows the vibe's OWN genres, not suggestions. */
  shortlist?: 'suggested' | 'selected-only';
}) {
  const atCap = selected.length >= MAX_GENRES;
  const shortlistIds =
    shortlist === 'selected-only' ? selected : buildGenreShortlist(selected, forYouGenres);

  function chip(id: string) {
    const pressed = selected.includes(id);
    return (
      <button
        key={id}
        type="button"
        aria-pressed={pressed}
        disabled={atCap && !pressed}
        onClick={() => onChange(toggleGenre(selected, id))}
        className={cn(chipClass, 'disabled:cursor-not-allowed disabled:opacity-35')}
      >
        {genreLabel(id)}
      </button>
    );
  }

  return (
    <fieldset>
      <legend className="mb-2 flex w-full items-baseline justify-between text-[13px] font-semibold text-paper">
        <span className="flex items-baseline gap-2">
          Genre
          {shortlist === 'suggested' && forYouGenres.length > 0 ? (
            <span className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-lamp">
              For you
            </span>
          ) : null}
        </span>
        {hint ? (
          <span
            aria-live="polite"
            className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim"
          >
            {hint}
          </span>
        ) : null}
      </legend>
      <div className="flex flex-wrap gap-2">
        {shortlistIds.map(chip)}
        <Sheet>
          <SheetTrigger className="rounded-full border border-dashed border-lamp/35 bg-lamp/[0.04] px-4 py-2 text-[13.5px] font-medium text-lamp transition-[color,border-color] duration-[120ms] ease-[ease] [-webkit-tap-highlight-color:transparent] hover:border-lamp/60 hover:text-paper">
            + All genres
          </SheetTrigger>
          <SheetContent side="bottom" className="flex max-h-[86vh] flex-col">
            <SheetHeader
              title="All genres"
              description="Pick up to three — they blend, and the first one leads."
            />
            <p
              aria-live="polite"
              className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-dim"
            >
              <b className={cn('font-bold', atCap ? 'text-warn' : 'text-lamp')}>
                {selected.length}
              </b>{' '}
              of {MAX_GENRES} picked
            </p>
            <div className="-mx-5 mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5">
              {GENRE_FAMILIES.map((family) => (
                <fieldset key={family.name} className="mb-4">
                  <legend className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-dim">
                    {family.name}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {family.genres.map((genre) => chip(genre.id))}
                  </div>
                </fieldset>
              ))}
            </div>
            <SheetClose className={cn(primaryButtonClass, 'mt-4 w-full')}>Done</SheetClose>
          </SheetContent>
        </Sheet>
      </div>
    </fieldset>
  );
}
