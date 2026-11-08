'use client';

// The player card's ONE transient action-failure notice (the `actionError`
// slot): truthful UX for any player write that did NOT land server-side —
// feedback actions (Save/Dislike) and the loop generation hold alike. Owned
// here so no action domain has to host another's failure presentation.

import { useCallback, useEffect, useRef } from 'react';

const ACTION_ERROR_DISMISS_MS = 6000;

/** A transient notice writer: shows `message`, auto-dismisses, newest wins. */
export function useActionNotice(
  patch: (next: { actionError: string | null }) => void,
): (message: string) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (message: string) => {
      patch({ actionError: message });
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        patch({ actionError: null });
      }, ACTION_ERROR_DISMISS_MS);
    },
    [patch],
  );
}
