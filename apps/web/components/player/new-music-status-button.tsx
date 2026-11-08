'use client';

// The player header's plain statement of whether new music is being bought. The
// button is the way into the New music sheet; its words come from
// `presentNewMusicStatus`.

import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NEW_MUSIC_ICONS } from './new-music-icons';
import { newMusicStatusLine, type NewMusicIcon, type NewMusicStatus } from './new-music-status';
import { useGenerationRing } from './use-generation-ring';

const ICON_COLOUR: Record<NewMusicIcon, string> = {
  generating: 'text-lamp',
  target: 'text-lamp',
  'no-limit': 'text-lamp',
  finished: 'text-muted',
  off: 'text-muted',
  paused: 'text-warn',
};

const RING_RADIUS = 14.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function RingProgress({ fraction }: { fraction: number }) {
  return (
    <svg
      data-testid="new-music-ring"
      viewBox="0 0 32 32"
      aria-hidden
      className="absolute inset-0 -rotate-90"
    >
      <circle
        cx="16"
        cy="16"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        stroke="currentColor"
        opacity="0.2"
      />
      <circle
        cx="16"
        cy="16"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={`${fraction * RING_LENGTH} ${RING_LENGTH}`}
        className="motion-safe:[transition:stroke-dasharray_500ms_ease]"
      />
    </svg>
  );
}

function iconSizeClass(icon: NewMusicIcon): string {
  if (icon === 'paused') return 'h-6 w-6';
  // The stopwatch's dial sits below its box centre, under the crown; this
  // brings the dial level with the text.
  if (icon === 'target') return 'h-[21px] w-[21px] -translate-y-[2.25px]';
  return 'h-[21px] w-[21px]';
}

/**
 * The 32px icon slot is always there, ring or not, so the ring appearing moves
 * nothing. Its spare width hangs into the left gutter, which keeps the bare
 * icon on the title's left edge.
 */
export function NewMusicStatusButton({
  status,
  generatingAhead,
  playableTracks,
  onOpen,
}: {
  status: NewMusicStatus;
  generatingAhead: number;
  /** The Session's playable Queue slots, oldest first. */
  playableTracks: readonly string[];
  onOpen: () => void;
}) {
  const ring = useGenerationRing(generatingAhead, playableTracks);
  const ringShown = ring.shown && status.icon !== 'paused';
  const icon = ringShown ? 'generating' : status.icon;
  const Icon = NEW_MUSIC_ICONS[icon];
  return (
    <button
      type="button"
      data-testid="player-new-music"
      onClick={onOpen}
      aria-label={`New music: ${newMusicStatusLine(status)}. Change.`}
      className={cn(
        '-ml-[5.5px] mr-auto inline-flex h-[42px] min-w-0 items-center gap-1 text-left text-[12.5px] font-medium',
        ICON_COLOUR[status.icon],
      )}
    >
      <span className="relative grid h-8 w-8 shrink-0 place-items-center">
        {ringShown ? <RingProgress fraction={ring.fraction} /> : null}
        <Icon
          aria-hidden
          className={cn(
            iconSizeClass(icon),
            status.icon === 'generating' && 'motion-safe:animate-pulse',
          )}
        />
      </span>
      {status.detail ? (
        <span className="flex min-w-0 flex-col justify-center">
          <span className="truncate leading-[1.2]">{status.text}</span>
          <span className="truncate text-[11px] leading-[1.25] text-muted tabular-nums">
            {status.detail}
          </span>
        </span>
      ) : (
        <>
          <span className="truncate desk:hidden">{status.short}</span>
          <span className="hidden truncate desk:inline">{status.text}</span>
        </>
      )}
      <ChevronDown aria-hidden className="h-3 w-3 shrink-0 text-dim max-[379px]:hidden" />
    </button>
  );
}
