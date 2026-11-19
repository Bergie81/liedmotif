'use client';

// A "sheet" (slide-in panel) is not a native Radix primitive — it is built on
// @radix-ui/react-dialog, the standard pattern. This keeps focus-trapping and
// accessibility from Dialog while presenting as an edge-anchored panel, which
// suits the mobile-first menu/controls surfaces.

import { useRef, type ComponentProps, type PointerEvent, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { DragAxis } from './drag-axis';
import { floatingSurfaceClass, iconButtonClass, overlayClass } from './design-system';
import { OfflineSheetMark } from './offline-sheet-mark';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

type SheetSide = 'left' | 'right' | 'bottom';

const sideClasses: Record<SheetSide, string> = {
  left: 'inset-y-0 left-0 h-full w-80 max-w-[85%] border-r',
  right: 'inset-y-0 right-0 h-full w-80 max-w-[85%] border-l',
  bottom:
    'inset-x-0 bottom-0 mx-auto max-h-[86vh] w-full max-w-[560px] rounded-t-[22px] border-x border-t pb-[calc(24px+env(safe-area-inset-bottom,0px))]',
};

export function SheetContent({
  className,
  children,
  side = 'left',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: SheetSide }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={cn('fixed inset-0 z-40', overlayClass)} />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 [background:var(--gradient-float)] p-5 data-[state=open]:animate-sheet-up',
          floatingSurfaceClass,
          sideClasses[side],
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({
  title,
  description,
  leading,
  closeLabel,
  closeDisabled = false,
  action,
  offlineMark = false,
}: {
  title: string;
  description?: ReactNode;
  leading?: ReactNode;
  /** The close button's accessible name — pass one where the title names the
   *  sheet's subject rather than the sheet itself. */
  closeLabel?: string;
  closeDisabled?: boolean;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** An options sheet whose rows go dark or drop out offline: while offline the
   *  header carries a sign that says why. */
  offlineMark?: boolean;
}) {
  const Body = action ? 'button' : 'div';
  const Text = action ? 'span' : 'div';
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <SheetGrabber disabled={closeDisabled} onDismiss={() => closeRef.current?.click()} />
      <div className="flex items-start gap-3">
        <Body
          type={action ? 'button' : undefined}
          onClick={action?.onClick}
          disabled={action?.disabled}
          aria-label={action?.label}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-3 text-left',
            action &&
              'rounded-[6px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lamp disabled:opacity-60',
          )}
        >
          {leading}
          <Text className="min-w-0 flex-1">
            {/* Display type sets its own leading: the body's 1.5 would open a
              half-line of air between the title and the line naming it. */}
            <SheetTitle
              asChild={Boolean(action)}
              className="block truncate font-display text-[18px] font-bold leading-6 tracking-[-0.01em]"
            >
              {action ? <span>{title}</span> : title}
            </SheetTitle>
            <SheetDescription asChild={Boolean(action)} className="block text-[13.5px] text-muted">
              {action ? <span>{description}</span> : description}
            </SheetDescription>
          </Text>
        </Body>
        {offlineMark ? <OfflineSheetMark /> : null}
        <SheetClose
          ref={closeRef}
          className={iconButtonClass}
          aria-label={closeLabel ?? `Close ${title}`}
          disabled={closeDisabled}
        >
          <X className="h-[19px] w-[19px]" />
        </SheetClose>
      </div>
    </>
  );
}

const DISMISS_DISTANCE_PX = 96;

/** The bar atop a bottom sheet. Dragging it down moves the sheet with the
 *  finger; a long drag or a fast flick dismisses it, anything less springs back.
 *  Dismissal goes through the close button so each sheet's own close handling
 *  and lock apply. The close button stays the keyboard path, so this is
 *  hidden from assistive tech. */
function SheetGrabber({ disabled, onDismiss }: { disabled: boolean; onDismiss: () => void }) {
  const drag = useRef<{ sheet: HTMLElement; y: DragAxis } | null>(null);

  function release(event: PointerEvent, cancelled: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    const dismisses =
      !cancelled &&
      event.clientY > current.y.start &&
      current.y.commits(event.clientY, DISMISS_DISTANCE_PX, event.timeStamp);
    if (dismisses) onDismiss();
    current.sheet.style.transition = 'transform 0.2s ease-out';
    current.sheet.style.transform = '';
  }

  return (
    <div
      aria-hidden
      data-testid="sheet-grabber"
      className="-mt-5 flex h-7 cursor-grab touch-none select-none justify-center pt-2 active:cursor-grabbing"
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        const sheet = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
        if (!sheet) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        sheet.style.transition = 'none';
        drag.current = { sheet, y: new DragAxis(event.clientY, event.timeStamp) };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const distance = Math.max(0, current.y.move(event.clientY, event.timeStamp));
        current.sheet.style.transform = distance ? `translateY(${distance}px)` : '';
      }}
      onPointerUp={(event) => release(event, false)}
      onPointerCancel={(event) => release(event, true)}
    >
      <div className="h-1 w-[38px] rounded-[2px] bg-line-2" />
    </div>
  );
}
