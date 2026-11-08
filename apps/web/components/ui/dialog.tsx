'use client';

import type { ComponentProps } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { floatingSurfaceClass, iconButtonClass, overlayClass } from './design-system';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogOverlay({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn('fixed inset-0 z-40', overlayClass, className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'animate-dialog-in rounded-card border [background:var(--gradient-float)] p-5',
          floatingSurfaceClass,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** The X in a dialog's top-right corner. Its look and place are fixed so the
 * close button sits in the same spot, at the same tap size, on every dialog. */
export function DialogCloseButton(
  props: Omit<ComponentProps<typeof DialogPrimitive.Close>, 'children' | 'className'>,
) {
  return (
    <DialogPrimitive.Close
      {...props}
      aria-label="Close"
      className={cn(iconButtonClass, 'absolute right-3 top-3')}
    >
      <X className="h-[18px] w-[18px]" aria-hidden />
    </DialogPrimitive.Close>
  );
}
