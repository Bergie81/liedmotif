'use client';

// The Lounge member filter: an "All" card plus one profile card per sharer,
// single-select. Tapping the lit card again lifts the narrowing. The strip
// scrolls sideways on phones and wraps from `desk` up, where a mouse has no
// swipe to reach the cards past the edge. Once the column is wide enough,
// sharer cards size to fit four per row beside the "All" card: the strip's
// `--all-card` and `--filter-gap` variables are the widths that row shares.

import { useId } from 'react';
import { Users } from 'lucide-react';
import { cn } from '@/lib/cn';
import { AvatarBadge } from '@/components/avatar-badge';
import { roundChipClass } from '@/components/ui/design-system';
import { playlistCardMetaLineClass } from '@/components/playlists/playlist-card-shell';
import { formatPlaylistTrackCount } from '@/components/playlists/playlist-view-model';
import type { SharerCard } from './lounge-view-model';

export function LoungeMemberFilter({
  cards,
  selected,
  onSelect,
}: {
  cards: SharerCard[];
  /** The selected sharer's user id; null = All. */
  selected: string | null;
  onSelect: (userId: string | null) => void;
}) {
  return (
    <div className="@container">
      <div
        role="group"
        aria-label="Filter by sharing member"
        className="flex gap-(--filter-gap) overflow-x-auto pb-2 pt-6 [--all-card:104px] [--filter-gap:0.75rem] desk:flex-wrap desk:overflow-visible"
      >
        <FilterCard
          on={selected === null}
          onClick={() => onSelect(null)}
          className="w-(--all-card) items-center justify-center text-center"
        >
          <span className={cn(roundChipClass, 'h-12 w-12 text-lamp')}>
            <Users className="h-5 w-5" aria-hidden />
          </span>
          <span className="block text-[14.5px] font-semibold">All</span>
        </FilterCard>
        {cards.map((card) => (
          <SharerFilterCard
            key={card.userId}
            card={card}
            on={selected === card.userId}
            onClick={() => onSelect(selected === card.userId ? null : card.userId)}
          />
        ))}
      </div>
    </div>
  );
}

/** The button is named by the person alone; count and description describe it. */
function SharerFilterCard({
  card,
  on,
  onClick,
}: {
  card: SharerCard;
  on: boolean;
  onClick: () => void;
}) {
  const id = useId();
  const nameId = `${id}-name`;
  const countId = `${id}-count`;
  const descriptionId = `${id}-description`;
  return (
    <FilterCard
      on={on}
      onClick={onClick}
      // The extra pixel keeps sub-pixel rounding from wrapping the fourth card.
      className="w-[224px] items-start text-left @min-[880px]:w-[calc((100%-var(--all-card)-4*var(--filter-gap)-1px)/4)]"
      labelledBy={nameId}
      describedBy={card.description ? `${countId} ${descriptionId}` : countId}
    >
      <span className="flex min-w-0 items-center gap-3">
        <AvatarBadge
          name={card.avatarName}
          imageUrl={card.imageUrl}
          className="h-12 w-12 text-[19px]"
        />
        <span className="min-w-0">
          <span id={nameId} className="block truncate text-[14.5px] font-semibold">
            {card.label}
          </span>
          <span id={countId} className={cn('mt-0.5 block', playlistCardMetaLineClass)}>
            {formatPlaylistTrackCount(card.sharedTrackCount)} shared
          </span>
        </span>
      </span>
      {card.description ? (
        <span id={descriptionId} className="break-words text-[12.5px] leading-[1.45] text-muted">
          {card.description}
        </span>
      ) : null}
    </FilterCard>
  );
}

/** One member-filter card: single-select, lamp-lit when on. */
function FilterCard({
  on,
  onClick,
  className,
  labelledBy,
  describedBy,
  children,
}: {
  on: boolean;
  onClick: () => void;
  className: string;
  labelledBy?: string;
  describedBy?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={onClick}
      className={cn(
        'flex flex-none flex-col gap-3 rounded-card border p-4 transition',
        on
          ? 'border-lamp/55 bg-lamp/10 text-lamp shadow-[0_0_14px_-4px_var(--lamp-glow)]'
          : 'border-line text-paper [background:var(--gradient-card)] shadow-[var(--shadow-card)] hover:border-line-2',
        className,
      )}
    >
      {children}
    </button>
  );
}
