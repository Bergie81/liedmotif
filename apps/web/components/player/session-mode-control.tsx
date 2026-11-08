'use client';

// The Session mode toggle's two player surfaces — the header icon beside the
// blend toggle and the options sheet's tile — over the ONE controller seam
// (`useSessionModeToggle`). Both wear the same glyph for the same Session, so
// whichever is reached first cancels an activation the other armed.

import { useId, type ComponentType } from 'react';
import { Infinity as InfinityIcon } from 'lucide-react';
import type { SessionMode } from '@liedmotif/shared';
import { iconButtonClass, menuTileClass } from '@/components/ui/design-system';
import { WithTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { SESSION_MODE_LABEL } from './session-mode-view';
import type { SessionModeToggleProps } from './use-session-mode-toggle';

/** What the icon table asks of a glyph, lucide's own icons included. */
interface ModeIconProps {
  className?: string;
  'aria-hidden'?: boolean;
}

/** lucide `Infinity`, verbatim — the glyph the struck twin negates. */
const INFINITY_PATH =
  'M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z';
const SLASH_PATH = 'm3 3 18 18';

/**
 * Lucide ships no struck Infinity, so it is drawn here in lucide's own idiom
 * (24 viewBox, stroke 2, round caps), the way its `*-off` icons read: the slash
 * cuts the glyph it negates. The cut is a mask rather than a background-coloured
 * halo, so one glyph serves the header over the page background and the sheet's
 * tile alike.
 */
function InfinityOffIcon({ className, 'aria-hidden': ariaHidden }: ModeIconProps) {
  // Per instance: the header button and the options tile can
  // both be showing this glyph at once.
  const maskId = `session-mode-struck-${useId()}`;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={ariaHidden}
    >
      <mask id={maskId}>
        <rect x="0" y="0" width="24" height="24" fill="white" stroke="none" />
        {/* Wider than the slash that hides behind it, which is what leaves a gap. */}
        <path d={SLASH_PATH} stroke="black" strokeWidth={4.5} />
      </mask>
      <path mask={`url(#${maskId})`} d={INFINITY_PATH} />
      <path d={SLASH_PATH} />
    </svg>
  );
}

/**
 * Endlessness, on and off. Both surfaces stay out of the arrow-loop family the
 * transport's playing-order button owns — that control sits in the same view,
 * and "does this Session still generate?" is a different question from "what
 * order do its Tracks play in?", so the two may never wear one glyph.
 * Exhaustive, like the copy table.
 */
const MODE_ICONS: Record<SessionMode, ComponentType<ModeIconProps>> = {
  keep_going: InfinityIcon,
  repeat: InfinityOffIcon,
};

/** An armed activation pulses the mode it is about to reach — the state is in
 *  the glyph itself, never in colour alone. */
function ModeGlyph({
  sessionMode,
  pending,
  className,
}: {
  sessionMode: SessionMode;
  pending: boolean;
  className: string;
}) {
  const Icon = MODE_ICONS[pending ? 'keep_going' : sessionMode];
  return (
    <Icon
      className={cn(className, pending && 'animate-pulse text-lamp motion-reduce:animate-none')}
      aria-hidden
    />
  );
}

/** The accessible name: it must also say what a press does, which the short
 *  name has no room for. */
function modeToggleLabel(sessionMode: SessionMode, pending: boolean): string {
  if (pending) return 'Cancel generating new Tracks';
  return sessionMode === 'keep_going'
    ? 'Generate new Tracks on — switch to Play existing Tracks'
    : 'Play existing Tracks — enable Generate new Tracks after five seconds';
}

/** Pressed-state colour, as a variant so it beats the base class's own. */
const modeToggleStateClass =
  'flex-none disabled:cursor-not-allowed aria-pressed:text-lamp aria-[pressed=false]:text-muted';

export function SessionModeToggleButton({
  sessionMode,
  pending,
  disabled,
  onToggle,
}: SessionModeToggleProps) {
  return (
    <WithTooltip label={pending ? 'Cancel Activation' : SESSION_MODE_LABEL[sessionMode]}>
      <button
        type="button"
        data-testid="player-session-mode-toggle"
        aria-label={modeToggleLabel(sessionMode, pending)}
        aria-pressed={sessionMode === 'keep_going'}
        disabled={disabled}
        onClick={onToggle}
        className={cn(iconButtonClass, modeToggleStateClass)}
      >
        <ModeGlyph sessionMode={sessionMode} pending={pending} className="h-[28px] w-[28px]" />
      </button>
    </WithTooltip>
  );
}

/** The options sheet's tile — like the blend tile it is NOT close-on-tap: the
 *  sheet stays up so the flipped glyph and label answer the tap in place. */
export function SessionModeToggleTile({
  sessionMode,
  pending,
  disabled,
  onToggle,
}: SessionModeToggleProps) {
  return (
    <button
      type="button"
      data-testid="player-session-mode-menu-toggle"
      aria-label={modeToggleLabel(sessionMode, pending)}
      aria-pressed={sessionMode === 'keep_going'}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        menuTileClass,
        modeToggleStateClass,
        'aria-pressed:border-lamp/45 aria-pressed:bg-lamp/[0.08] light:aria-pressed:border-lamp-fill/55 light:aria-pressed:bg-lamp-fill/[0.13]',
      )}
    >
      <ModeGlyph sessionMode={sessionMode} pending={pending} className="h-5 w-5" />
      {SESSION_MODE_LABEL[sessionMode]}
    </button>
  );
}
