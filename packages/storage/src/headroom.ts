// Free-space headroom, the availability floor under every write.
//
// A full `/data` does not degrade one feature — it breaks writes app-wide, and
// on the single-host compose deployment that includes Postgres. So the last
// bytes of the volume are reserved rather than spent: an upload or a download is
// refused while there is still room to recover, which the analysis staging path
// already does for its temp directory.

import type { StorageProvider } from './index';

/**
 * Reserved tail of the volume. Sized to leave a database and its WAL room to
 * keep running (and an operator room to delete something) after the app stops
 * accepting new bytes — not to the size of any single write.
 */
export const STORAGE_HEADROOM_MARGIN_BYTES = 256 * 1024 * 1024;

/**
 * Whether `incomingBytes` may be written without eating into the reserved tail.
 * The default of 0 asks the plain question — is the volume already too full to
 * accept anything? — for a caller who cannot know the size in advance.
 *
 * A provider that reports no free space (object storage) always has headroom:
 * there is no volume to exhaust, and the storage quota is what bounds growth
 * there. A `statfs` that fails is treated the same way — a headroom check must
 * never be the thing that breaks uploads.
 */
export async function hasStorageHeadroom(
  storage: Pick<StorageProvider, 'freeBytes'>,
  incomingBytes = 0,
): Promise<boolean> {
  if (!storage.freeBytes) return true;
  let free: number;
  try {
    free = await storage.freeBytes();
  } catch {
    return true;
  }
  return free >= incomingBytes + STORAGE_HEADROOM_MARGIN_BYTES;
}
