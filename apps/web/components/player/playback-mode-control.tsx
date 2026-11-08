'use client';

import type { MouseEvent } from 'react';
import { Repeat, Repeat1, Shuffle } from 'lucide-react';
import type { PlaybackMode } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { transportButtonClass } from '@/components/ui/design-system';
import { WithTooltip } from '@/components/ui/tooltip';
import {
  presentPlaybackMode,
  type PlaybackModeIcon as PlaybackModeIconName,
} from './player-presentation';

const ICONS = {
  repeat: Repeat,
  'repeat-one': Repeat1,
  shuffle: Shuffle,
} satisfies Record<PlaybackModeIconName, typeof Repeat>;

export function PlaybackModeControl({
  mode,
  onCycle,
  disabled = false,
  variant,
  sourceNoun = 'Session',
}: {
  mode: PlaybackMode;
  onCycle?: () => void;
  disabled?: boolean;
  variant: 'transport' | 'mini';
  /** The engaged source's wording: Loop Session vs Loop Playlist. */
  sourceNoun?: 'Session' | 'Playlist';
}) {
  const presentation = presentPlaybackMode(mode, sourceNoun);
  const Icon = ICONS[disabled ? 'repeat' : presentation.icon];
  const highlighted = !disabled && presentation.highlighted;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (variant === 'mini') {
      event.preventDefault();
      event.stopPropagation();
    }
    onCycle?.();
  }

  return (
    <span className="relative">
      <WithTooltip label={`${presentation.label} — switch to ${presentation.nextLabel}`}>
        <button
          type="button"
          data-testid={variant === 'mini' ? 'mini-playback-mode' : 'player-playback-mode'}
          aria-label={`Playback mode: ${presentation.label} — switch to ${presentation.nextLabel}`}
          aria-pressed={highlighted}
          disabled={disabled}
          onClick={handleClick}
          className={cn(
            variant === 'transport'
              ? transportButtonClass
              : 'inline-flex h-[42px] w-[42px] items-center justify-center rounded-xl [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)] hover:text-paper desk:hidden desk:h-[26px] desk:w-6 desk:rail-exp:inline-flex desk:rail-exp:h-[30px] desk:rail-exp:w-[30px]',
            highlighted ? 'text-lamp' : 'text-muted',
          )}
        >
          <Icon
            className={
              variant === 'transport' ? 'h-[23px] w-[23px]' : 'h-[18px] w-[18px] desk:h-4 desk:w-4'
            }
            aria-hidden
          />
        </button>
      </WithTooltip>
      {!disabled ? (
        <span className="sr-only" role="status" aria-live="polite">
          Playback mode: {presentation.label}
        </span>
      ) : null}
    </span>
  );
}
