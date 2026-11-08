'use client';

import { useSyncExternalStore } from 'react';
import { formatSessionLastActive } from '@/components/sessions/session-list-model';

const noSubscription = () => () => {};

/**
 * "6 min ago" for a timestamp. The server's text is a render-time guess: the
 * reader's clock can differ from the server's. Hydration keeps the server's
 * text node even when the client's text differs, so the span remounts once
 * mounted to show the reader's own.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  return (
    <span key={mounted ? 'client' : 'server'} suppressHydrationWarning>
      {formatSessionLastActive(iso)}
    </span>
  );
}
