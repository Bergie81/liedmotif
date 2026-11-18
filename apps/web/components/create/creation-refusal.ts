// What a refused creation shows, decided in one place for every way a new
// Session starts: a refusal with ways out (no headroom) opens the blocked
// dialog, anything else stays the caller's line of text.
//
// Callable from components and plain hooks alike: the open refusal is module
// state, and the one `CreationRefusalHost` in the app shell renders it. Tests
// read it with `shownCreationRefusal()` and reset with `closeCreationRefusal()`.

import { useSyncExternalStore } from 'react';
import type { ApiErrorCode } from '@liedmotif/shared';

/** The refusals the blocked dialog explains. Each one needs its own title. */
export type CreationRefusalKind = 'headroom';

export const CREATION_REFUSAL_TITLES: { readonly [Kind in CreationRefusalKind]: string } = {
  headroom: 'Not enough Tracks left to start',
};

export interface CreationRefusal {
  kind: CreationRefusalKind;
  message: string;
}

const DIALOG_KINDS: Partial<Record<ApiErrorCode, CreationRefusalKind>> = {
  session_headroom_blocked: 'headroom',
};

/** The dialog refusal an API error is, or null when it is a plain failure. */
export function creationRefusalFor(error: {
  code: ApiErrorCode;
  message: string;
}): CreationRefusal | null {
  const kind = DIALOG_KINDS[error.code];
  return kind ? { kind, message: error.message } : null;
}

/** The label a More Like This failure is shown with, wherever it was tapped. */
export const MORE_LIKE_THIS_FAILED = 'More Like This didn’t start';

let shown: CreationRefusal | null = null;
const listeners = new Set<() => void>();

function commit(next: CreationRefusal | null): void {
  shown = next;
  for (const listener of listeners) listener();
}

/**
 * Show a refused creation: a dialog refusal opens the blocked dialog and
 * returns null; any other failure returns `"<failureLabel>: <message>"` for
 * the caller to show as it shows its other errors.
 */
export function presentCreationFailure(
  error: { code: ApiErrorCode; message: string },
  failureLabel: string,
): string | null {
  const refusal = creationRefusalFor(error);
  if (!refusal) return `${failureLabel}: ${error.message}`;
  showCreationRefusal(refusal);
  return null;
}

/** Open the blocked dialog for a refusal the caller already classified. */
export function showCreationRefusal(refusal: CreationRefusal): void {
  commit(refusal);
}

/** The refusal the blocked dialog shows now, for tests. */
export function shownCreationRefusal(): CreationRefusal | null {
  return shown;
}

export function closeCreationRefusal(): void {
  if (shown) commit(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The refusal the blocked dialog shows now, if any. */
export function useShownCreationRefusal(): CreationRefusal | null {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  );
}
