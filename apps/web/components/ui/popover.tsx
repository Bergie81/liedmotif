'use client';

import type { ComponentProps } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/cn';
import { floatingSurfaceClass } from './design-system';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-64 animate-pop-in rounded-[14px] border bg-panel-2 p-3 text-[13.5px]',
          floatingSurfaceClass,
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
