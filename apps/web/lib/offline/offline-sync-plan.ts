// The offline sync planner: one pure decision of what a device should fetch,
// refresh and delete so its Available-offline copy matches the server.
//
// The device holds each Track once, however many marks list it, and keeps it
// while any mark does. The cap counts audio and covers, as the device stores
// them: one cover per Track, also when Tracks share one. It is decided from the
// server's byte sizes before anything downloads, and never by evicting: a mark
// whose missing Tracks do not fit is refused whole, older marks keep their room
// first, and a stored copy's new or missing cover takes only the room the marks
// leave, else waits for a later sync.
//
// Another owner's Track stays only while it is Lounge-audible: a sync deletes
// it once no manifest lists it, and its copy stops playing when no sync has
// confirmed it for a week (`offlineCopyPlayable`).

import type { OfflineManifest, OfflineManifestTrack } from '@liedmotif/shared';

/** How long a Lounge Track's offline copy plays without a successful sync. */
export const LOUNGE_OFFLINE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a stored copy may play at `now`. The listener's own Tracks always
 * do. A Lounge Track does until a week has passed since the last successful
 * sync, the last time the server confirmed the share still holds; the next
 * sync then purges it or confirms it again.
 */
export function offlineCopyPlayable(
  track: Pick<OfflineManifestTrack, 'fromLounge'>,
  lastSyncedAt: number | null,
  now: number,
): boolean {
  if (!track.fromLounge) return true;
  return lastSyncedAt !== null && now - lastSyncedAt < LOUNGE_OFFLINE_EXPIRY_MS;
}

/** A marked collection with the manifest the server answered for it this sync. */
export interface PlannedMark {
  key: string;
  markedAt: number;
  manifest: OfflineManifest;
}

/** What the device already holds for one Track. */
export interface StoredTrack {
  trackId: string;
  version: string;
  /** Everything stored for the Track (audio and cover). */
  bytes: number;
  /** The cover the stored copy shows, held or not. */
  coverImageId: string | null;
  /** 0 when its cover failed to arrive; a refresh fetches it again. */
  coverBytes: number;
}

export interface OfflineRefusal {
  key: string;
  /** What the mark's missing Tracks need. */
  neededBytes: number;
  /** What the cap leaves after everything kept and planned before this mark. */
  freeBytes: number;
}

/** A stored Track's metadata to fetch again; its audio stays. */
export interface OfflineRefresh {
  track: OfflineManifestTrack;
  /** False when its cover does not fit: the copy goes without until a later sync. */
  withCover: boolean;
}

export interface OfflineSyncPlan {
  /** Tracks not on the device, each once, oldest mark first, in play order. */
  downloads: OfflineManifestTrack[];
  /** Stored Tracks whose metadata version moved, or whose missing cover now fits. */
  refreshes: OfflineRefresh[];
  /** Stored Tracks no mark lists. */
  deletions: string[];
  refusals: OfflineRefusal[];
}

export function planOfflineSync(input: {
  marks: readonly PlannedMark[];
  stored: readonly StoredTrack[];
  capBytes: number;
}): OfflineSyncPlan {
  const storedById = new Map(input.stored.map((entry) => [entry.trackId, entry]));
  const listed = new Map<string, OfflineManifestTrack>();
  for (const mark of input.marks) {
    for (const track of mark.manifest.tracks) {
      if (!listed.has(track.trackId)) listed.set(track.trackId, track);
    }
  }

  const deletions = input.stored
    .filter((entry) => !listed.has(entry.trackId))
    .map((entry) => entry.trackId);
  let usedBytes = input.stored
    .filter((entry) => listed.has(entry.trackId))
    .reduce((sum, entry) => sum + entry.bytes, 0);
  const downloads: OfflineManifestTrack[] = [];
  const planned = new Set<string>();
  const refusals: OfflineRefusal[] = [];

  const oldestFirst = [...input.marks].sort((a, b) => a.markedAt - b.markedAt);
  for (const mark of oldestFirst) {
    const missing = new Map<string, OfflineManifestTrack>();
    for (const track of mark.manifest.tracks) {
      if (!storedById.has(track.trackId) && !planned.has(track.trackId)) {
        missing.set(track.trackId, track);
      }
    }
    const neededBytes = [...missing.values()].reduce(
      (sum, track) => sum + (track.byteSize ?? 0) + coverBytes(track),
      0,
    );
    // A mark with nothing to fetch costs no room, so a device already past the
    // cap — sizes the server did not know count as 0 — keeps every mark it holds.
    if (missing.size > 0 && usedBytes + neededBytes > input.capBytes) {
      refusals.push({
        key: mark.key,
        neededBytes,
        freeBytes: Math.max(0, input.capBytes - usedBytes),
      });
      continue;
    }
    usedBytes += neededBytes;
    for (const track of missing.values()) {
      planned.add(track.trackId);
      downloads.push(track);
    }
  }

  const refreshes: OfflineRefresh[] = [];
  for (const track of listed.values()) {
    const copy = storedById.get(track.trackId);
    if (!copy) continue;
    const coverHeld = copy.coverImageId === track.coverImageId && copy.coverBytes > 0;
    // The refresh replaces the stored cover, so it needs only the difference.
    const extraBytes = coverHeld ? 0 : coverBytes(track) - copy.coverBytes;
    const coverMissing = track.coverImageId !== null && !coverHeld;
    // A cover that takes no more room than the stored one always comes along,
    // so a device past its cap keeps the covers it already holds.
    const withCover = extraBytes <= 0 || usedBytes + extraBytes <= input.capBytes;
    if (copy.version === track.version && !(coverMissing && withCover)) continue;
    // Room a refresh frees counts only from the next sync: a write that fails
    // keeps the stored cover, so no other cover may take that room now.
    if (withCover && extraBytes > 0) usedBytes += extraBytes;
    refreshes.push({ track, withCover });
  }

  return { downloads, refreshes, deletions, refusals };
}

/** An absent size, from a manifest an older app stored, counts as 0. */
function coverBytes(track: OfflineManifestTrack): number {
  return track.coverImageId === null ? 0 : (track.coverByteSize ?? 0);
}
