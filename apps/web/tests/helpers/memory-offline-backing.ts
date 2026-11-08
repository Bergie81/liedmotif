import type { OfflineBacking, OfflineBackingStore } from '@/lib/offline/offline-store';

/** An in-memory offline-store backing: one Map per store, writes applied all at once. */
export function memoryOfflineBacking(): OfflineBacking {
  const stores = new Map<OfflineBackingStore, Map<string, unknown>>();
  const of = (name: OfflineBackingStore) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store, key) => of(store).get(key),
    getAll: async (store) => [...of(store).values()],
    write: async (writes) => {
      for (const { store, key, value } of writes) {
        if (value === undefined) of(store).delete(key);
        else of(store).set(key, value);
      }
    },
    clear: async () => stores.clear(),
  };
}
