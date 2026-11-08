'use client';

// The sign that a Playlist or Session plays without a connection, set before its
// Track count (a Search row's match text, the Player's status line), or after the
// title on the phone's mini player. It appears only once this device holds every
// Track: a partial copy shows nothing, and the options menu's row carries the count
// and the reasons.

import { useSyncExternalStore } from 'react';
import { CircleArrowDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { offlineStatusSnapshot, subscribeOfflineStatus } from '@/lib/offline/device-offline';
import { offlineMarkKey, type OfflineMarkKind } from '@/lib/offline/offline-store';
import type { OfflineMarkStatus } from '@/lib/offline/offline-sync';

/** Undefined while unmarked, on the server render, and until the store opens. */
export function useOfflineMarkStatus(
  kind: OfflineMarkKind,
  id: string,
): OfflineMarkStatus | undefined {
  const key = offlineMarkKey(kind, id);
  return useSyncExternalStore(
    subscribeOfflineStatus,
    () => offlineStatusSnapshot().get(key),
    () => undefined,
  );
}

export function OfflineMark({
  kind,
  id,
  className = 'mr-1.5',
}: {
  kind: OfflineMarkKind;
  id: string;
  /** Spacing against its neighbor: by default it leads a Track count. */
  className?: string;
}) {
  const status = useOfflineMarkStatus(kind, id);
  if (status?.state !== 'ready') return null;
  return (
    <span
      role="img"
      aria-label="Available offline"
      title="Available offline"
      data-testid="offline-mark"
      className={cn('inline-flex flex-none align-[-2px] text-lamp', className)}
    >
      <CircleArrowDown className="h-[14px] w-[14px]" strokeWidth={2.25} aria-hidden />
    </span>
  );
}
