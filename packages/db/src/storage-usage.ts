// Storage accounting for the configured `storageQuotaBytes`.
//
// The quota is a boundary on stored BYTES, and every table that holds bytes
// records their size on the row — track audio assets, Person reference photos,
// voice recordings, and cover images with their derived tile renditions. Summing
// those rows is therefore a database question, not a storage-adapter one — which
// also keeps it correct on S3, where there is no volume to stat. Avatars are the
// one documented exclusion: one per user, replaced rather than accumulated, and
// addressed by `user.image` with no row of their own.
//
// The sum is measured periodically and cached in `app_settings`, never computed
// per request: an upload and a buffer admission must not each pay for four
// aggregate scans. Between measurements the cached total is kept honest by the
// reservation below, which projects a write BEFORE it happens and folds the
// bytes that actually landed into the total afterwards — so admission answers
// "would this write cross the line?", not "are we already over it?".

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './client';
import {
  APP_SETTINGS_KEYS,
  appSettings,
  coverImages,
  personReferencePhotos,
  trackAudioAssets,
  voiceRecordings,
} from './schema';
import { readSetting, writeSetting } from './setup/settings';
import type { DbOrTx } from './transactions';

/** A measured byte total and when it was taken. */
export interface StorageUsage {
  totalBytes: number;
  /** ISO-8601; the reader decides how much staleness it tolerates. */
  measuredAt: string;
  /**
   * Bytes admitted but not yet written — in-flight uploads and downloads. Absent
   * on a total measured before reservations existed, which reads as zero.
   */
  reservedBytes?: number;
}

/**
 * Sum the byte sizes of everything the app has stored.
 *
 * Audio rows only count when they actually reference stored bytes: an asset row
 * carrying nothing but an encrypted provider URL occupies no disk.
 */
export async function measureStoredBytes(db: DbOrTx): Promise<number> {
  // Schema-referenced rather than literal table names: a renamed table or column
  // has to break this sum at compile time, because the failure it would
  // otherwise cause — a whole category silently dropping out — looks exactly
  // like an instance that is simply under quota.
  const result = await db.execute(sql`
    select
      (select coalesce(sum(${trackAudioAssets.byteSize}), 0) from ${trackAudioAssets}
         where ${trackAudioAssets.storageKey} is not null)
      + (select coalesce(sum(${personReferencePhotos.byteSize}), 0)
           from ${personReferencePhotos})
      + (select coalesce(sum(${voiceRecordings.byteSize}), 0) from ${voiceRecordings})
      + (select coalesce(sum(${coverImages.byteSize}), 0)
           + coalesce(sum(${coverImages.renditionByteSize}), 0) from ${coverImages})
      as total
  `);
  // Postgres returns a `bigint` sum as a string, and a transaction handle's
  // `execute` is untyped — hence the cast plus the widening `Number`.
  const rows = (result as unknown as { rows: { total: number | string }[] }).rows;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Measure the total and cache it. Called by the hourly sweep and at worker boot.
 *
 * A fresh measurement also zeroes the reservation counter: it is the only thing
 * that can, and without it a process that died mid-write would hold bytes
 * reserved forever. In-flight reservations at that instant are simply forgotten
 * — one measurement window of less conservative admission, against a leak that
 * would otherwise never heal. A settle landing between the measurement and this
 * write is lost or counted twice for the same window, and the next measurement
 * corrects either way: the total answers "may growth continue", not "exactly how
 * many bytes are in use".
 */
export async function refreshStorageUsage(
  db: Database,
  now: Date = new Date(),
): Promise<StorageUsage> {
  const usage: StorageUsage = {
    totalBytes: await measureStoredBytes(db),
    measuredAt: now.toISOString(),
    reservedBytes: 0,
  };
  await writeSetting(db, APP_SETTINGS_KEYS.storageUsage, usage);
  return usage;
}

/**
 * The cached total, or null when nothing has measured it yet. A null is "not
 * known", and callers treat it as such: an instance whose first measurement has
 * not run must not have every upload refused.
 */
export async function getStorageUsage(db: DbOrTx): Promise<StorageUsage | null> {
  return readSetting<StorageUsage>(db, APP_SETTINGS_KEYS.storageUsage);
}

/**
 * The most one track's audio may be — what a final download reserves against
 * the quota before its first byte arrives, what its body is cut off at, and so
 * what the buffer must see room for before it buys a track. One number, because
 * a reservation the download can exceed bounds nothing, and a purchase gate
 * looser than the reservation pays for audio the download then refuses to keep.
 * Generous against a long track at a high bitrate, small enough to still be a
 * bound.
 */
export const MAX_TRACK_AUDIO_BYTES = 64 * 1024 * 1024;

/** What the quota counts: measured bytes plus everything currently reserved. */
export function accountedStorageBytes(usage: StorageUsage): number {
  return usage.totalBytes + (usage.reservedBytes ?? 0);
}

/**
 * Whether a write of `bytesNeeded` must be refused: the accounted total —
 * measured bytes plus everything currently reserved — leaves less room than
 * that under the configured quota. The same predicate `reserveStorageBytes`
 * admits by, so an admission that answers "fits" here is one the write itself
 * will be granted.
 *
 * An unmeasured total never refuses. A quota of 0 refuses every write, exactly
 * like a `0` generation cap — the limit fields share one vocabulary, and "0
 * means unlimited" would be a trap in a control whose whole purpose is to bound
 * growth.
 */
export function isStorageQuotaReached(
  usage: StorageUsage | null,
  quotaBytes: number | undefined,
  bytesNeeded: number,
): boolean {
  if (!usage || quotaBytes === undefined) return false;
  return accountedStorageBytes(usage) + bytesNeeded > quotaBytes;
}

/** Room claimed against the quota for one write, to be settled once it ends. */
interface StorageByteReservation {
  /** What was claimed, which is what settling gives back. */
  bytes: number;
}

/** SQL for one numeric field of the cached usage object, defaulting to zero. */
const usageField = (field: 'totalBytes' | 'reservedBytes') =>
  sql`coalesce((${appSettings.value} ->> ${field})::bigint, 0)`;

/**
 * Claim room for a write of at most `bytes`, or null when the quota has none.
 *
 * The claim is the whole admission decision, taken in ONE conditional statement
 * so that concurrent writers cannot each read the same pre-write total and
 * jointly overshoot: the row lock on the cached total serializes them, and the
 * second writer re-evaluates the fit against the first one's claim.
 *
 * `bytes` is what the caller could store at most, not what it will — the
 * reservation is deliberately pessimistic while the write is in flight, and
 * `settleStorageBytes` replaces it with the bytes that landed. Callers take the
 * pair through `withStorageReservation`, which is what guarantees the settle.
 */
export async function reserveStorageBytes(
  db: DbOrTx,
  args: { bytes: number; quotaBytes: number | undefined },
): Promise<StorageByteReservation | null> {
  const quotaBytes = args.quotaBytes ?? null;
  const claimed = await db
    .update(appSettings)
    .set({
      value: sql`${appSettings.value} || jsonb_build_object(
        'reservedBytes', ${usageField('reservedBytes')} + ${args.bytes})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appSettings.key, APP_SETTINGS_KEYS.storageUsage),
        sql`${quotaBytes}::bigint is null
            or ${usageField('totalBytes')} + ${usageField('reservedBytes')} + ${args.bytes}
               <= ${quotaBytes}::bigint`,
      ),
    )
    .returning({ key: appSettings.key });
  if (claimed.length > 0) return { bytes: args.bytes };
  // No row matched: either the quota refused this write, or nothing has measured
  // the total yet — and an unmeasured instance must never refuse an upload.
  return (await getStorageUsage(db)) === null ? { bytes: 0 } : null;
}

/**
 * End a reservation, counting `writtenBytes` as stored. Zero is the failure
 * path: the claim is released and nothing is accounted. Folding the written
 * bytes into the cached total is what keeps sequential writes between two
 * measurements from each admitting against the same stale figure.
 */
export async function settleStorageBytes(
  db: DbOrTx,
  reservation: StorageByteReservation,
  writtenBytes: number,
): Promise<void> {
  await db
    .update(appSettings)
    .set({
      value: sql`${appSettings.value} || jsonb_build_object(
        'totalBytes', ${usageField('totalBytes')} + ${writtenBytes},
        'reservedBytes', greatest(${usageField('reservedBytes')} - ${reservation.bytes}, 0))`,
      updatedAt: new Date(),
    })
    .where(eq(appSettings.key, APP_SETTINGS_KEYS.storageUsage));
}

/**
 * Run `write` with room for `bytes` claimed against the quota, or answer `null`
 * when the quota has none. Whatever `write` reports through `recordStored` is
 * what the total ends up carrying; everything else it claimed is given back.
 *
 * The claim and its settlement live in one function because they have to be one
 * decision: a caller that forgets the settle holds room nothing occupies until
 * the next measurement, and a caller that settles twice gives back room twice.
 * Settling never throws — it can only ever have held room, so it must not turn a
 * finished write into a failure.
 */
export async function withStorageReservation<T>(
  db: DbOrTx,
  args: { bytes: number; quotaBytes: number | undefined },
  write: (recordStored: (byteSize: number) => void) => Promise<T>,
): Promise<T | null> {
  const reservation = await reserveStorageBytes(db, args);
  if (!reservation) return null;
  let writtenBytes = 0;
  try {
    return await write((byteSize) => {
      writtenBytes += byteSize;
    });
  } finally {
    await settleStorageBytes(db, reservation, writtenBytes).catch(() => undefined);
  }
}
