import type { ComponentType } from 'react';
import { AudioLines, CircleCheck, CircleOff, Infinity as InfinityIcon, Timer } from 'lucide-react';
import type { NewMusicIcon } from './new-music-status';

/** lucide's CirclePause has bars too small to read beside the row's glyphs. */
function BoldCirclePause({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9 7.5v9M15 7.5v9" strokeWidth={2.5} />
    </svg>
  );
}

export const NEW_MUSIC_ICONS: Record<
  NewMusicIcon,
  ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
> = {
  generating: AudioLines,
  target: Timer,
  'no-limit': InfinityIcon,
  finished: CircleCheck,
  paused: BoldCirclePause,
  off: CircleOff,
};
