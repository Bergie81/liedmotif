'use client';

// The blend toggle's two player surfaces — the header icon next to the
// retention actions and the options sheet's tile — over the ONE controller seam
// (`blendEnabled`/`toggleBlend`). The toggle is a persisted playback setting,
// not a Track action, so it never disables with an empty deck; a flip applies
// to the next transition (the engine reads the live gate at every edge).
//
// The glyph carries the state in shape AND colour, never colour alone: crossed
// envelopes in lamp while blending is on, a single hard-cut step in muted grey
// while it is off. The two swap by crossfading in place, so the control
// demonstrates the transition it governs.

import { cn } from '@/lib/cn';
import { iconButtonClass, menuTileClass } from '@/components/ui/design-system';
import { WithTooltip } from '@/components/ui/tooltip';

interface BlendToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

/** The short name both surfaces show — the tip on the icon, the row's own text. */
function blendToggleName(enabled: boolean): string {
  return enabled ? 'Blend Tracks' : 'Don’t blend Tracks';
}

/** The accessible name: it must also say what a press does, which the short
 *  name has no room for. */
function blendToggleLabel(enabled: boolean): string {
  return enabled
    ? 'Blended Track transitions on — switch to hard cuts'
    : 'Blended Track transitions off — switch to blends';
}

const glyphLayerClass =
  'absolute inset-0 h-full w-full transition-[opacity,transform] duration-150 ease-out';

/** Both states stacked in one slot; the inactive layer fades and shrinks away. */
function BlendGlyph({ enabled, className }: { enabled: boolean; className: string }) {
  const svgProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  return (
    <span className={cn('relative inline-block flex-none', className)} aria-hidden>
      <svg
        {...svgProps}
        className={cn(glyphLayerClass, 'text-lamp', !enabled && 'scale-[0.88] opacity-0')}
      >
        <path d="M2 5h4l12 14h4" />
        <path d="M2 19h4L18 5h4" />
      </svg>
      <svg
        {...svgProps}
        className={cn(glyphLayerClass, 'text-muted', enabled && 'scale-[0.88] opacity-0')}
      >
        <path d="M2 5h10v14h10" />
      </svg>
    </span>
  );
}

export function BlendToggleButton({ enabled, onToggle }: BlendToggleProps) {
  return (
    <WithTooltip label={blendToggleName(enabled)}>
      <button
        type="button"
        data-testid="player-blend-toggle"
        aria-label={blendToggleLabel(enabled)}
        aria-pressed={enabled}
        onClick={onToggle}
        className={cn(iconButtonClass, 'flex-none')}
      >
        <BlendGlyph enabled={enabled} className="h-[21px] w-[21px]" />
      </button>
    </WithTooltip>
  );
}

/** The options sheet's tile — the one tile that reports rather than acts, so it
 * looks pressed instead of merely tappable and is NOT close-on-tap: the sheet
 * stays up so the flipped label and glyph answer the tap in place. */
export function BlendToggleTile({ enabled, onToggle }: BlendToggleProps) {
  return (
    <button
      type="button"
      data-testid="player-blend-menu-toggle"
      aria-label={blendToggleLabel(enabled)}
      aria-pressed={enabled}
      onClick={onToggle}
      className={cn(
        menuTileClass,
        'aria-[pressed=false]:text-muted aria-pressed:border-lamp/45 aria-pressed:bg-lamp/[0.08] light:aria-pressed:border-lamp-fill/55 light:aria-pressed:bg-lamp-fill/[0.13]',
      )}
    >
      <BlendGlyph enabled={enabled} className="h-5 w-5" />
      {blendToggleName(enabled)}
    </button>
  );
}
