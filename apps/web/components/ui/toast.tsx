'use client';

// The toaster: renders what `toast.*` (lib/toast.ts) shows, once, from the root
// layout. Toasts float over the page and above every sheet and dialog, so
// nothing in the page moves when one appears.

import { useEffect, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  closeToast,
  dismissErrorToasts,
  useToastEntries,
  type ToastEntry,
  type ToastTone,
} from '@/lib/toast';
import { iconButtonClass } from './design-system';

const TONES: Record<
  ToastTone,
  {
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    border: string;
    iconColor: string;
    /** In milliseconds; an error waits until it is closed. */
    duration: number;
    /** Radix's foreground type is announced assertively, background politely. */
    type: 'foreground' | 'background';
  }
> = {
  success: {
    icon: CircleCheck,
    border: 'border-signal/40',
    iconColor: 'text-signal',
    duration: 4_000,
    type: 'background',
  },
  info: {
    icon: Info,
    border: 'border-line-2',
    iconColor: 'text-muted',
    duration: 4_000,
    type: 'background',
  },
  warning: {
    icon: TriangleAlert,
    border: 'border-lamp/45',
    iconColor: 'text-lamp',
    duration: 8_000,
    type: 'foreground',
  },
  error: {
    icon: CircleAlert,
    border: 'border-warn/50',
    iconColor: 'text-warn',
    duration: Infinity,
    type: 'foreground',
  },
};

export function Toaster() {
  const entries = useToastEntries();
  const stack = useStackRun(entries.length === 0);
  useCloseErrorsOnRouteChange(entries.at(-1)?.id ?? 0);
  return (
    <ToastPrimitive.Provider key={stack} label="Notification" swipeDirection="up">
      {entries.map((entry) => (
        <ToastItem key={entry.id} entry={entry} />
      ))}
      {/* Each toast mounts after the ones before it, so the column runs
          reversed to put the newest on top. Above sheets, dialogs, popovers and
          tooltips (z-50). */}
      <ToastPrimitive.Viewport
        className={cn(
          'fixed z-[60] mx-auto flex flex-col-reverse gap-2 outline-none',
          'left-4 right-4 top-[calc(env(safe-area-inset-top,0px)+12px)] max-w-[var(--shell-col)]',
          'desk:left-auto desk:right-[calc(var(--assistant)+24px)] desk:top-6 desk:w-[360px] desk:max-w-none',
        )}
      />
    </ToastPrimitive.Provider>
  );
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  const tone = TONES[entry.tone];
  const Icon = tone.icon;
  return (
    <ToastPrimitive.Root
      open={entry.open}
      onOpenChange={(open) => {
        if (!open) closeToast(entry.id);
      }}
      type={tone.type}
      duration={tone.duration}
      data-tone={entry.tone}
      // An open modal sheet or dialog turns pointer events off on every layer
      // beneath it, a toast shown before it opened included. A tap on a toast
      // must land on the toast, never fall through to the overlay and close it.
      style={{ pointerEvents: 'auto' }}
      className={cn(
        'flex items-start gap-2.5 rounded-[14px] border py-2 pl-3.5 pr-1.5 text-[13.5px] leading-snug text-paper',
        '[background:var(--gradient-float)] shadow-[var(--shadow-float)]',
        'data-[state=closed]:animate-toast-out data-[state=open]:animate-toast-in',
        'data-[swipe=move]:translate-y-[var(--radix-toast-swipe-move-y)]',
        'data-[swipe=cancel]:translate-y-0 data-[swipe=cancel]:[transition:translate_.2s_ease-out]',
        'data-[swipe=end]:translate-y-[var(--radix-toast-swipe-end-y)]',
        tone.border,
      )}
    >
      <Icon className={cn('mt-2.5 h-4 w-4 shrink-0', tone.iconColor)} aria-hidden />
      {/* Radix announces a toast's text nodes run together; this reads them as
          sentences instead. */}
      <div
        className="min-w-0 flex-1 py-2"
        data-radix-toast-announce-exclude=""
        data-radix-toast-announce-alt={announcedText(entry)}
      >
        {entry.title ? (
          <ToastPrimitive.Title className="font-semibold">{entry.title}</ToastPrimitive.Title>
        ) : null}
        <ToastPrimitive.Description className={cn(entry.title && 'text-muted')}>
          {entry.message}
        </ToastPrimitive.Description>
        {entry.link ? (
          <Link
            href={entry.link.href}
            prefetch={false}
            className="mt-1 inline-block text-[12.5px] font-medium underline underline-offset-2"
          >
            {entry.link.label}
          </Link>
        ) : null}
      </div>
      {/* The standard 42 px icon button, its hit area grown by 1 px a side to
          the 44 px tap target. */}
      <ToastPrimitive.Close
        aria-label="Close notification"
        className={cn(
          iconButtonClass,
          "relative shrink-0 after:absolute after:-inset-px after:content-['']",
        )}
      >
        <X className="h-[17px] w-[17px]" aria-hidden />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

/** Counts the times the stack has emptied. Radix pauses every timer while focus
 *  is in the viewport, and closing the last toast from its button leaves focus
 *  there with nothing left to resume it, so the next toast would never time
 *  out. Remounting the provider on an empty stack starts each run unpaused. */
function useStackRun(empty: boolean): number {
  const [run, setRun] = useState({ count: 0, empty });
  if (run.empty !== empty) {
    setRun({ count: empty ? run.count + 1 : run.count, empty });
  }
  return run.count;
}

function announcedText(entry: ToastEntry): string {
  return [entry.title, entry.message, entry.link?.label]
    .flatMap((part) => (part ? [/[.!?…]$/.test(part) ? part : `${part}.`] : []))
    .join(' ');
}

/** `newestId` is the newest toast this render shows. The new page's own mount
 *  effects run before this one, so an error they raise is newer and stays. */
function useCloseErrorsOnRouteChange(newestId: number) {
  const pathname = usePathname();
  const shownOn = useRef(pathname);
  useEffect(() => {
    if (shownOn.current === pathname) return;
    shownOn.current = pathname;
    dismissErrorToasts(newestId);
  }, [pathname, newestId]);
}
