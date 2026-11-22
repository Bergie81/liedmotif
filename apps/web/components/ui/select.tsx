'use client';

import { useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { floatingSurfaceClass } from './design-system';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'inline-flex h-[42px] items-center justify-between gap-2 rounded-xl border border-line-2 bg-[var(--field-bg)] shadow-[var(--shadow-field)] px-4 text-[14px] text-paper',
        'focus-visible:border-lamp/60',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDown className="h-4 w-4 text-muted" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          'z-50 max-h-[min(320px,var(--radix-select-content-available-height))] overflow-hidden rounded-[14px] border bg-panel-2 text-[13.5px]',
          floatingSurfaceClass,
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** A heading over one `SelectGroup`, for a list long enough to need sections. */
export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn(
        'px-3 pb-1 pt-3 font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim',
        className,
      )}
      {...props}
    />
  );
}

/**
 * One option. `media` sits before the text and `description` under it; both
 * stay outside the item's text, so the closed trigger and type-ahead keep to
 * the option's name.
 */
export function SelectItem({
  className,
  children,
  media,
  description,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item> & {
  media?: ReactNode;
  description?: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <SelectPrimitive.Item
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        'relative flex cursor-default select-none items-center gap-3 rounded-[9px] py-2 pl-8 pr-3 text-muted',
        'data-[highlighted]:bg-paper/[0.07] data-[highlighted]:text-paper data-[highlighted]:outline-none data-[state=checked]:text-lamp',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 inline-flex items-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-3.5 w-3.5" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
      {media}
      <span className="min-w-0">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description ? <span id={descriptionId}>{description}</span> : null}
      </span>
    </SelectPrimitive.Item>
  );
}
