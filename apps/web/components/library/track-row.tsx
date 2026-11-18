'use client';

import Image from 'next/image';
import { useState, type ReactNode } from 'react';
import type { TrackSummary } from '@liedmotif/shared';
import { Disc3, EllipsisVertical, Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { coverArtSrc } from '@/components/player/player-presentation';
import { iconButtonClass } from '@/components/ui/design-system';

export type PreviewState = 'idle' | 'playing' | 'paused' | 'ended';
export interface TrackRowBadge {
  label: string;
}

export function TrackRow({
  track,
  metadata,
  context,
  badges = [],
  previewState,
  busy,
  onPreview,
  onOptions,
  optionsLabel,
  optionsIcon,
  minimalCoverRounding = false,
}: {
  track: TrackSummary;
  metadata: string;
  /** One extra line under the metadata (search's match-context line). */
  context?: ReactNode;
  badges?: TrackRowBadge[];
  previewState: PreviewState;
  busy: boolean;
  onPreview: () => void;
  /** Omitted by a caller whose rows have no acts of their own. The button's
   *  slot stays either way, so a list does not reflow when it drops them. */
  onOptions?: (opener: HTMLButtonElement) => void;
  optionsLabel?: string;
  optionsIcon?: ReactNode;
  /** Library and Playlist lists keep their covers' rounding to a hairline. */
  minimalCoverRounding?: boolean;
}) {
  const unavailable = track.audioUrl === null || track.status === 'failed';
  const title = track.title ?? 'Untitled Track';

  return (
    <article
      data-testid="library-item"
      data-track-id={track.id}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-2 last:border-b-0',
        unavailable && 'opacity-50',
      )}
    >
      <button
        type="button"
        data-testid="library-play"
        onClick={onPreview}
        disabled={unavailable}
        className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] items-center gap-3 text-left disabled:cursor-not-allowed"
        aria-label={previewLabel(title, previewState, unavailable, track.status === 'failed')}
      >
        <TrackCover
          key={track.coverImageId ?? 'none'}
          coverImageId={track.coverImageId}
          minimalRounding={minimalCoverRounding}
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 truncate text-[14.5px] font-semibold">
            {track.favoritedAt ? (
              <Star className="h-[13px] w-[13px] shrink-0 fill-lamp text-lamp" />
            ) : null}
            <span className="truncate">{title}</span>
            {badges.map((badge) => (
              <TrackBadge key={badge.label}>{badge.label}</TrackBadge>
            ))}
          </span>
          <span
            suppressHydrationWarning
            className="mt-[3px] block truncate font-mono text-[10.5px] tracking-[0.04em] text-dim"
          >
            {metadata}
          </span>
          {context}
        </span>
      </button>

      <div className="h-[42px] w-[42px]">
        {onOptions ? (
          <button
            type="button"
            className={iconButtonClass}
            disabled={busy}
            onClick={(event) => onOptions(event.currentTarget)}
            aria-label={optionsLabel ?? `Options for ${title}`}
          >
            {optionsIcon ?? <EllipsisVertical className="h-[19px] w-[19px]" />}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** The whole row is the play control, so its label names the Track — a screen
 *  reader hears what it would act on, not a bare "Play". */
function previewLabel(
  title: string,
  previewState: PreviewState,
  unavailable: boolean,
  failed: boolean,
): string {
  if (failed) return `${title} — could not be kept`;
  if (unavailable) return `${title} — audio unavailable`;
  switch (previewState) {
    case 'playing':
      return `Pause ${title}`;
    case 'ended':
      return `Replay ${title}`;
    default:
      return `Play ${title}`;
  }
}

/** The record icon sits beneath the cover image, so it doubles as the loading
 *  placeholder and the fallback when there is no cover or the image errors. */
function TrackCover({
  coverImageId,
  minimalRounding,
}: {
  coverImageId: string | null;
  minimalRounding: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        'relative block h-12 w-12 overflow-hidden bg-panel-2',
        minimalRounding ? 'rounded-[4px]' : 'rounded-[10px]',
      )}
    >
      <Disc3 className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-muted" />
      {coverImageId && !failed ? (
        <Image
          src={coverArtSrc(coverImageId, 'thumb')}
          alt=""
          width={48}
          height={48}
          className="relative h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : null}
    </span>
  );
}

function TrackBadge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-[4px] border border-line-2 px-1 py-[2px] font-mono text-[9px] font-normal uppercase tracking-[0.12em] text-dim">
      {children}
    </span>
  );
}
