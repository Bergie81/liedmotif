'use client';

// Keeps this device's Available-offline copy in sync while the app is open:
// when it opens or comes back to the foreground, when the connection returns,
// shortly after a library write that may have changed a marked collection, and
// as a playing Session's new Tracks land while that Session is marked.
// Every sync waits until the device store is handed to the signed-in User,
// which empties it when it held another account's music. Each open also
// refreshes the Offline Library the service worker falls back to without a
// connection. Renders nothing.

import { useEffect } from 'react';
import {
  deviceOffline,
  offlineStatusSnapshot,
  onConnectionRegained,
} from '@/lib/offline/device-offline';
import { onLibraryWrite, onSessionTracksLanded } from '@/lib/offline/library-writes';
import { readyOfflineLibrary } from '@/lib/offline/offline-library-cache';
import { offlineMarkKey } from '@/lib/offline/offline-store';
import { offlineSupported } from '@/lib/offline/offline-support';

/** A burst of writes (a reorder, several adds) or landings settles into one sync. */
const LIBRARY_WRITE_SETTLE_MS = 1500;

export function OfflineSyncHost({ userId }: { userId: string }) {
  useEffect(() => {
    if (!offlineSupported()) return;
    void readyOfflineLibrary();
    const claimed = deviceOffline().then(async (offline) => {
      await offline?.claim(userId);
      return offline;
    });
    const sync = () => void claimed.then((offline) => offline?.sync());
    const onForeground = () => {
      if (document.visibilityState === 'visible') sync();
    };
    let settle: ReturnType<typeof setTimeout> | undefined;

    sync();
    document.addEventListener('visibilitychange', onForeground);
    const stopOnline = onConnectionRegained(sync);
    const syncSoon = () => {
      clearTimeout(settle);
      settle = setTimeout(sync, LIBRARY_WRITE_SETTLE_MS);
    };
    const stopWrites = onLibraryWrite(syncSoon);
    const stopLandings = onSessionTracksLanded((sessionId) => {
      if (offlineStatusSnapshot().has(offlineMarkKey('session', sessionId))) syncSoon();
    });
    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      stopOnline();
      stopWrites();
      stopLandings();
      clearTimeout(settle);
    };
  }, [userId]);

  return null;
}
