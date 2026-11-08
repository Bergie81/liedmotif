// Which Tracks the Player can play from this device's offline store instead of
// streaming them, answered at once: a deck loads synchronously (a tapped
// Track's play stays inside its gesture), so the answer cannot wait on
// IndexedDB. The index holds each stored Track's audio as the store hands it
// back, a Blob over the stored file whose bytes are read only when a deck
// plays it, and reads the store again whenever it changes. A Track it does not
// know streams. So does another owner's Track while online: a revoke reaches
// the device only at the next sync, but stops a stream at once. Offline its
// copy plays until a week has passed without a sync.

import { offlineCopyPlayable } from './offline-sync-plan';
import type { OfflineStore } from './offline-store';

export interface StoredAudio {
  /** The stored audio of a Track this device may play now, or null: it streams. */
  get(trackId: string): Blob | null;
  /** Reads the store again; a call during a read queues one more. Never
   *  rejects: a read that fails keeps the last answer. */
  refresh(): Promise<void>;
}

interface Held {
  audio: Blob;
  fromLounge: boolean;
}

export function createStoredAudio(
  store: Pick<OfflineStore, 'list' | 'lastSyncedAt' | 'getFile'>,
  device: { online: () => boolean; now?: () => number },
): StoredAudio {
  const now = device.now ?? Date.now;
  let held = new Map<string, Held>();
  let lastSyncedAt: number | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  async function read(): Promise<void> {
    const [copies, syncedAt] = await Promise.all([store.list(), store.lastSyncedAt()]);
    const entries = await Promise.all(
      copies.map(async ({ trackId, track }): Promise<[string, Held] | null> => {
        // A Track keeps its audio while it stays stored: only its metadata
        // is ever refreshed.
        const audio = held.get(trackId)?.audio ?? (await store.getFile(trackId, 'audio'));
        return audio ? [trackId, { audio, fromLounge: track.fromLounge }] : null;
      }),
    );
    held = new Map(entries.filter((entry) => entry !== null));
    lastSyncedAt = syncedAt;
  }

  return {
    get(trackId) {
      const entry = held.get(trackId);
      if (!entry || (entry.fromLounge && device.online())) return null;
      return offlineCopyPlayable(entry, lastSyncedAt, now()) ? entry.audio : null;
    },

    refresh() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await read();
          } while (again);
        } catch {
          // The next change to the store reads it again.
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
