'use client';

// The Loop a Part toggle in the player's control row, next to the blend toggle.
// It reads the tool's state off the controller, so it answers the same whether
// the tool was opened here or from the options menu.

import { iconButtonClass } from '@/components/ui/design-system';
import { SectionLoopGlyph } from '@/components/ui/glyphs';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import type { SectionLoopControl } from './playback-controller-api';

export function SectionLoopToggleButton({ open, available, onToggle }: SectionLoopControl) {
  return (
    <WithTooltip label="Loop a Part">
      <button
        type="button"
        data-testid="player-section-loop-toggle"
        aria-label={open ? 'Loop a Part on — back to the progress bar' : 'Loop a Part'}
        aria-pressed={open}
        disabled={!available}
        onClick={onToggle}
        className={cn(
          iconButtonClass,
          'flex-none disabled:opacity-40 aria-pressed:text-lamp aria-pressed:hover:text-lamp',
        )}
      >
        <SectionLoopGlyph className="h-[21px] w-[21px]" />
      </button>
    </WithTooltip>
  );
}
