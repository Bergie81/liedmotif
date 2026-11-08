import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

/** Tones name the chip's border accent — only `signal` recolors the text.
 * The dark-glass surface sits on the cover art's fixed artwork background, so
 * it is intentionally theme-independent; the text needs only a light-theme
 * lift to stay readable over the glass. */
const TONE_CLASS = {
  muted: 'border-line-2 text-muted light:text-[#d4ccdf]',
  signal: 'border-signal/50 text-signal light:text-[#a5e6bc]',
  lamp: 'border-lamp/35 text-muted light:text-[#d4ccdf]',
} as const;

/** A status chip overlaid on the player's cover art: mono micro-copy on dark
 * glass with a pulsing lamp dot. All cover overlays render through this so
 * the surfaces stay visually interchangeable. */
export function CoverChip({
  tone = 'muted',
  dotClassName,
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<'span'> & {
  tone?: keyof typeof TONE_CLASS;
  dotClassName?: string;
}) {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center gap-2 rounded-[7px] border [background:rgba(10,8,16,0.78)] p-2 font-mono text-[9.5px] uppercase tracking-[0.12em] backdrop-blur-[6px]',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-[7px] w-[7px] shrink-0 rounded-full bg-lamp motion-safe:animate-dot-gen',
          dotClassName,
        )}
      />
      {children}
    </span>
  );
}
