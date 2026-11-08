// This device's one offline sync, opened on first use over IndexedDB and shared
// by every surface in the tab: the sync host, each Available-offline toggle,
// sign-out, and the Player, which plays the audio it stores instead of
// streaming it. Null wherever offline storage is unavailable — a plain-HTTP
// page or a browser refusing IndexedDB.

import { offlineSupported } from '@/lib/offline/offline-support';
import { isOnline, subscribeOnline } from '@/lib/online-state';
import { openIndexedDbBacking } from './indexeddb-backing';
import { offlineServer } from './offline-server';
import { createOfflineStore } from './offline-store';
import { createStoredAudio, type StoredAudio } from './stored-audio';
import {
  createOfflineSync,
  DEFAULT_OFFLINE_CAP_BYTES,
  type OfflineMarkStatus,
  type OfflineSync,
} from './offline-sync';

let opening: Promise<OfflineSync | null> | null = null;
let opened: OfflineSync | null = null;
let storedAudio: StoredAudio | null = null;
const listeners = new Set<() => void>();
const NO_STATUS: ReadonlyMap<string, OfflineMarkStatus> = new Map();

function notify() {
  for (const listener of listeners) listener();
}

function persistStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}

export function deviceOffline(): Promise<OfflineSync | null> {
  opening ??= (async () => {
    if (!offlineSupported()) return null;
    try {
      const store = createOfflineStore(await openIndexedDbBacking());
      opened = createOfflineSync({
        store,
        server: offlineServer,
        capBytes: DEFAULT_OFFLINE_CAP_BYTES,
        persist: persistStorage,
      });
      const audio = createStoredAudio(store, { online: isOnline });
      storedAudio = audio;
      opened.subscribe(() => {
        void audio.refresh();
        notify();
      });
      void audio.refresh();
      notify();
      return opened;
    } catch {
      return null;
    }
  })();
  return opening;
}

/** Empties the device's offline store and marks — signing out must leave no music behind. */
export async function wipeDeviceOffline(): Promise<void> {
  await (await deviceOffline())?.wipe().catch(() => undefined);
}

export function subscribeOfflineStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The stored audio of a Track this device may play now, or null: it streams.
 *  Answers at once, and null until the store has opened. */
export function storedTrackAudio(trackId: string): Blob | null {
  return storedAudio?.get(trackId) ?? null;
}

/** Every mark's status on this device; empty until the store has opened. */
export function offlineStatusSnapshot(): ReadonlyMap<string, OfflineMarkStatus> {
  return opened?.status() ?? NO_STATUS;
}

/** Calls back on each offline → online transition of the app-wide online state. */
export function onConnectionRegained(listener: () => void): () => void {
  let wasOnline = isOnline();
  return subscribeOnline(() => {
    const online = isOnline();
    if (online && !wasOnline) listener();
    wasOnline = online;
  });
}
