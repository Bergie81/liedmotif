// The browser backing under the offline store: one IndexedDB database with an
// object store per store name, keys given explicitly. Blobs are kept as Blobs,
// so reading a Track's metadata or listing the store never pulls audio into
// memory.

import type { OfflineBacking, OfflineBackingStore } from './offline-store';

const DATABASE_NAME = 'liedmotif-offline';
const DATABASE_VERSION = 1;
const STORES: readonly OfflineBackingStore[] = ['tracks', 'files', 'marks', 'meta'];

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted.'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
      }
    };
    open.onsuccess = () => {
      // A newer version opened in another tab must not wait on this one.
      open.result.onversionchange = () => open.result.close();
      resolve(open.result);
    };
    open.onerror = () => reject(open.error);
  });
}

export async function openIndexedDbBacking(): Promise<OfflineBacking> {
  const db = await openDatabase();
  return {
    get: (store, key) => settled(db.transaction(store).objectStore(store).get(key)),
    getAll: (store) => settled(db.transaction(store).objectStore(store).getAll()),
    async write(writes) {
      if (writes.length === 0) return;
      const transaction = db.transaction([...new Set(writes.map((w) => w.store))], 'readwrite');
      for (const { store, key, value } of writes) {
        if (value === undefined) transaction.objectStore(store).delete(key);
        else transaction.objectStore(store).put(value, key);
      }
      await committed(transaction);
    },
    async clear() {
      const transaction = db.transaction([...STORES], 'readwrite');
      for (const store of STORES) transaction.objectStore(store).clear();
      await committed(transaction);
    },
  };
}
