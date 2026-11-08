'use client';

import type { ComponentProps } from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/cn';

export function Slider({
  className,
  hideThumb = false,
  trackClassName,
  rangeClassName,
  'aria-label': ariaLabel,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root> & {
  /** Render the bar without its knob — for a disabled slider whose value
   * means nothing yet (e.g. track progress before the length is known). */
  hideThumb?: boolean;
  /** Extra classes for the rail behind the range. */
  trackClassName?: string;
  /** Extra classes for the filled range (e.g. a completion tint). */
  rangeClassName?: string;
}) {
  return (
    <SliderPrimitive.Root
      className={cn('relative flex w-full touch-none select-none items-center', className)}
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          'relative h-[6px] w-full grow rounded-full bg-paper/10 light:bg-paper/15',
          trackClassName,
        )}
      >
        <SliderPrimitive.Range
          className={cn(
            'absolute h-full rounded-full [background:var(--gradient-meter)] shadow-[var(--shadow-meter)]',
            rangeClassName,
          )}
        />
      </SliderPrimitive.Track>
      {/* The `slider` role lives on the THUMB in Radix — the caller's label
          must land there to become the control's accessible name. */}
      <SliderPrimitive.Thumb
        className={cn(
          'block h-5 w-5 rounded-full border-2 border-lamp bg-paper shadow-[0_0_12px_var(--lamp-glow)] light:border-lamp-fill light:bg-panel light:shadow-[0_1px_3px_rgba(16,22,34,0.22),0_0_0_4px_rgba(245,150,18,0.14)]',
          hideThumb && 'hidden',
        )}
        aria-label={ariaLabel ?? 'Value'}
      />
    </SliderPrimitive.Root>
  );
}
