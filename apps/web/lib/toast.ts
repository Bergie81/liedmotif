// The app's one way to report an event: something that just happened, like
// "Profile saved." or "Delete failed". A state that stays true until something
// changes it belongs inline where the thing lives, never here.
//
// Callable from components and plain hooks alike, with no context to thread:
// the store is module state, and the one `Toaster` in the root layout reads it.
// Tests read what was shown with `shownToasts()` and reset with `toast.dismiss()`.

import { useSyncExternalStore } from 'react';

export type ToastTone = 'success' | 'info' | 'warning' | 'error';

export type ToastLink = { label: string; href: string };

export type ToastOptions = {
  /** A toast with the key of a visible one replaces it. Defaults to tone plus
   *  message, so the same failure twice shows once; pass one when a retry
   *  should replace or `toast.dismiss` its earlier error. */
  key?: string;
  title?: string;
  link?: ToastLink;
};

export type ShownToast = {
  id: number;
  key: string;
  tone: ToastTone;
  message: string;
  title?: string;
  link?: ToastLink;
};

export type ToastEntry = ShownToast & { open: boolean };

const MAX_VISIBLE = 3;
/** A closed toast stays rendered this long, so its exit animation can play. */
const EXIT_MS = 200;

let entries: readonly ToastEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const NONE: readonly ToastEntry[] = [];

function commit(next: readonly ToastEntry[]): void {
  entries = next;
  for (const listener of listeners) listener();
}

function close(shouldClose: (entry: ToastEntry) => boolean): void {
  const closing = entries.filter((entry) => entry.open && shouldClose(entry));
  if (closing.length === 0) return;
  const ids = new Set(closing.map((entry) => entry.id));
  commit(entries.map((entry) => (ids.has(entry.id) ? { ...entry, open: false } : entry)));
  setTimeout(() => commit(entries.filter((entry) => !ids.has(entry.id))), EXIT_MS);
}

function show(tone: ToastTone, message: string, options: ToastOptions = {}): void {
  const key = options.key ?? `${tone}:${message}`;
  close((entry) => entry.key === key);
  const entry: ToastEntry = { id: nextId++, key, tone, message, open: true };
  if (options.title !== undefined) entry.title = options.title;
  if (options.link !== undefined) entry.link = options.link;
  commit([...entries, entry]);
  const open = entries.filter((visible) => visible.open);
  const overflow = new Set(open.slice(0, Math.max(0, open.length - MAX_VISIBLE)));
  close((visible) => overflow.has(visible));
}

export const toast = {
  success: (message: string, options?: ToastOptions) => show('success', message, options),
  info: (message: string, options?: ToastOptions) => show('info', message, options),
  warning: (message: string, options?: ToastOptions) => show('warning', message, options),
  error: (message: string, options?: ToastOptions) => show('error', message, options),
  /** Closes the toast with this key; without one, closes every toast. */
  dismiss: (key?: string) => close((entry) => key === undefined || entry.key === key),
};

/** Errors wait to be closed, but never outlive the page they belong to. */
export function dismissErrorToasts(): void {
  close((entry) => entry.tone === 'error');
}

/** The toasts on screen now, oldest first. */
export function shownToasts(): ShownToast[] {
  return entries.filter((entry) => entry.open).map(({ open: _open, ...shown }) => shown);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every rendered toast, oldest first, including those playing their exit. */
export function useToastEntries(): readonly ToastEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => entries,
    () => NONE,
  );
}

/** Called when a rendered toast closes itself: its timer ran out, or it was swiped or closed. */
export function closeToast(id: number): void {
  close((entry) => entry.id === id);
}
