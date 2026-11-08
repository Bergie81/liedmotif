'use client';

import type { ComponentProps } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/cn';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-[8px] border border-line-2 bg-panel-2 px-2.5 py-1.5 text-[12px] text-paper shadow-[var(--shadow-tooltip)]',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/** One labeled tooltip around its trigger — the standard icon-button tip.
 * Timing comes from the app-wide `TooltipProvider` in the root layout, which is
 * what lets neighbouring tips share a skip window. Hover/focus only, never on
 * touch (Radix semantics), so the trigger still needs its own `aria-label`. */
export function WithTooltip({
  label,
  side = 'top',
  children,
}: {
  label: string;
  side?: ComponentProps<typeof TooltipPrimitive.Content>['side'];
  children: ComponentProps<typeof TooltipPrimitive.Trigger>['children'];
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
