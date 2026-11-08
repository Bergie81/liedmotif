'use client';

// The Available-offline switch for one collection: the first row of its options
// menu, with the sync state under the label — "Downloading 12 / 30" while the
// device fetches, "Ready offline" once it holds every Track. The mark lives on
// this device only. Absent wherever the page cannot store music offline (plain
// HTTP, no IndexedDB).

import { useState, useSyncExternalStore } from 'react';
import { CircleArrowDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBinaryBytes } from '@/lib/format-bytes';
import { deviceOffline } from '@/lib/offline/device-offline';
import { offlineSupported } from '@/lib/offline/offline-support';
import type { OfflineMarkKind } from '@/lib/offline/offline-store';
import type { OfflineRefusal } from '@/lib/offline/offline-sync-plan';
import type { OfflineMarkStatus } from '@/lib/offline/offline-sync';
import { useOnline } from '@/lib/online-state';
import { Switch } from '@/components/ui/controls';
import { menuRowDescriptionClass } from '@/components/ui/design-system';
import { menuRowClassName } from '@/components/ui/menu-row';
import { OFFLINE_HINT } from '@/components/ui/online-only';
import { useOfflineMarkStatus } from './offline-mark';

const subscribeToNothing = () => () => undefined;

/** False on the server render, which cannot know how the page was opened. */
export function useOfflineSupported(): boolean {
  return useSyncExternalStore(subscribeToNothing, offlineSupported, () => false);
}

function refusalLine(refusal: Pick<OfflineRefusal, 'neededBytes' | 'freeBytes'>): string {
  return `Not enough offline space on this device: it needs ${formatBinaryBytes(
    refusal.neededBytes,
  )}, ${formatBinaryBytes(refusal.freeBytes)} is free. Settings → Storage sets the cap.`;
}

/** A mark's sync state in words; the same line wherever a mark is shown. */
export function statusLine(status: OfflineMarkStatus | undefined): string {
  if (!status) return 'Keep it on this device to play without a connection';
  switch (status.state) {
    case 'downloading':
      return `Downloading ${status.done} / ${status.total}`;
    case 'paused':
      return `${status.done} / ${status.total} on this device · the rest follows when online`;
    case 'ready':
      return 'Ready offline';
    case 'empty':
      return 'No tracks to keep yet';
    case 'refused':
      return refusalLine(status);
  }
}

export function OfflineMenuRow({ kind, id }: { kind: OfflineMarkKind; id: string }) {
  const supported = useOfflineSupported();
  const status = useOfflineMarkStatus(kind, id);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Marking reads the server; unmarking frees the device's space on its own.
  const markBlocked = !useOnline() && status === undefined;

  if (!supported) return null;

  async function toggle(next: boolean) {
    const offline = await deviceOffline();
    if (!offline) return;
    setBusy(true);
    setMessage(null);
    try {
      if (next) {
        const result = await offline.mark(kind, id);
        if (!result.marked) setMessage(refusalLine(result.refusal));
      } else {
        await offline.unmark(kind, id);
      }
    } catch {
      setMessage('Could not reach Liedmotif. Try again when you are online.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={menuRowClassName()}>
      <CircleArrowDown
        className={cn(
          'h-[18px] w-[18px] flex-none',
          status?.state === 'ready' ? 'text-lamp' : 'text-muted',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate">Available offline</p>
        <p role="status" data-testid="offline-status" className={menuRowDescriptionClass}>
          {message ?? statusLine(status)}
        </p>
      </div>
      <Switch
        checked={status !== undefined}
        disabled={busy || markBlocked}
        title={markBlocked ? OFFLINE_HINT : undefined}
        aria-busy={busy}
        aria-label="Available offline"
        data-testid="offline-toggle"
        onCheckedChange={(next) => void toggle(next)}
      />
    </div>
  );
}
