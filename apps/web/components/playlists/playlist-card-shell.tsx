'use client';

// The one playlist-card chassis: square artwork over a body row, the whole
// card a link, with an optional play overlay riding the cover. The Library's
// Playlists grid and the Lounge tiles both render THIS component —
// what differs between them is only what each puts in the body and after it.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Play } from 'lucide-react';
import { cn } from '@/lib/cn';
import { cardShellClass } from '@/components/ui/design-system';
import { PlaylistCover } from './playlist-cover';

/** Both of a card's meta lines read as one block, so they share the type. */
export const playlistCardMetaLineClass =
  'truncate font-mono text-[10.5px] uppercase tracking-[0.06em] text-dim';

/** The pin flag's chassis on the cover's top-right corner: the Lounge tile's
 *  toggle and the Library card's marker read as the same thing. */
export const playlistCardPinFlagClass =
  'absolute right-1.5 top-1.5 grid h-[26px] w-[26px] place-items-center rounded-lg bg-[rgba(15,13,22,0.72)] backdrop-blur-[6px]';

export function PlaylistCardShell({
  href,
  openLabel,
  coverImageId,
  mosaicCoverImageIds,
  onPlay,
  playLabel,
  playTestId,
  testId,
  children,
  trailing,
  coverFlag,
}: {
  /** Where the card-as-link opens (detail for own playlists, visitor view for foreign ones). */
  href: string;
  openLabel: string;
  coverImageId: string | null;
  mosaicCoverImageIds: string[];
  /** The play overlay; omit it and the cover stays a plain link target. */
  onPlay?: () => void;
  playLabel?: string;
  playTestId?: string;
  testId?: string;
  /** The body's text column (name + meta lines). */
  children: ReactNode;
  /** Rendered after the text column — the grid's options menu. */
  trailing?: ReactNode;
  /** Rides the cover's top-right corner (the pin flag). */
  coverFlag?: ReactNode;
}) {
  return (
    <div
      className={cn(
        cardShellClass,
        'group relative overflow-hidden transition hover:border-line-2',
      )}
      data-testid={testId}
    >
      <Link href={href} aria-label={openLabel} className="absolute inset-0 z-10" />
      <div className="relative">
        <PlaylistCover
          coverImageId={coverImageId}
          mosaicCoverImageIds={mosaicCoverImageIds}
          className="aspect-square w-full"
        />
        {coverFlag}
        {/* Hidden until the pointer says it can hover; a touch screen never
            fires that, so there it stays visible. */}
        {onPlay ? (
          <button
            type="button"
            onClick={onPlay}
            aria-label={playLabel}
            data-testid={playTestId}
            className="absolute bottom-2 right-2 z-20 grid h-[38px] w-[38px] translate-y-1 place-items-center rounded-full text-[var(--on-lamp)] opacity-0 shadow-[var(--shadow-primary)] transition-[opacity,transform] duration-150 [background:var(--gradient-primary)] group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100"
          >
            <Play className="h-[15px] w-[15px] fill-current" aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">{children}</div>
        {trailing}
      </div>
    </div>
  );
}
