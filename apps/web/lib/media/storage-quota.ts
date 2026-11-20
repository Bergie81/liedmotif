// The storage admission gate for upload routes.
//
// Two independent ceilings, both answered before any bytes are buffered or
// written: the quota the admin configured (`storageQuotaBytes`) and the free
// space actually left on the volume. The first is a policy the admin set; the
// second is the host telling us it cannot take more, which no configuration can
// override.
//
// The quota half is a CLAIM on the periodically measured total, never a
// re-measurement: room for the largest thing this route could store is reserved
// atomically for the length of the request and settled with what actually
// landed, so neither a burst of concurrent uploads nor a run of sequential ones
// can each admit against the same figure and jointly cross the line.

import { getUsageLimits, withStorageReservation } from '@liedmotif/db';
import { hasStorageHeadroom } from '@liedmotif/storage';
import { apiError } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { getStorageProvider } from '@/lib/providers/providers';
import { cachedUserProfile } from '@/lib/request-cache';

/**
 * The quota is instance-wide and only the Admin can raise it, so a Member is
 * told who can fix it, never pointed at an admin-only setting.
 */
const QUOTA_MESSAGES = {
  admin:
    'The storage quota is full. Delete something you no longer keep, or raise the quota in Settings.',
  member: 'Storage on this server is full. The admin needs to free space or raise the quota.',
} as const;

const DISK_MESSAGE = 'The storage volume is nearly full, so new uploads are paused.';

/**
 * Report bytes that actually landed in storage. Call it once per object written;
 * anything not reported is released instead of accounted, so a request that
 * refuses or throws costs the quota nothing.
 */
export type RecordStoredBytes = (byteSize: number) => void;

/**
 * Serve `handle` with room for `maxStoredBytes` claimed against the quota, or
 * answer with the refusal to send instead. `maxStoredBytes` is the surface's own
 * ceiling, not the actual body: the claim precedes the body read, so what it
 * bounds is the largest thing this route could store.
 */
export async function withStorageAdmission(
  ownerUserId: string,
  maxStoredBytes: number,
  handle: (recordStored: RecordStoredBytes) => Promise<Response>,
): Promise<Response> {
  const db = getDb();
  const { storageQuotaBytes } = await getUsageLimits(db);
  const served = await withStorageReservation(
    db,
    { bytes: maxStoredBytes, quotaBytes: storageQuotaBytes },
    async (recordStored) => {
      if (!(await hasStorageHeadroom(getStorageProvider(), maxStoredBytes))) {
        return apiError('limit_reached', DISK_MESSAGE);
      }
      return handle(recordStored);
    },
  );
  if (served) return served;
  const profile = await cachedUserProfile(db, ownerUserId);
  return apiError('limit_reached', QUOTA_MESSAGES[profile?.role === 'member' ? 'member' : 'admin']);
}
