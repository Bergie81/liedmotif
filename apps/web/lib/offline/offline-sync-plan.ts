// The offline sync planner: one pure decision of what a device should fetch,
// refresh and delete so its Available-offline copy matches the server.
//
// The device holds each Track once, however many marks list it, and keeps it
// while any mark does. The cap is decided from the server's byte sizes before
// anything downloads, and never by evicting: a mark whose missing Tracks do not
// fit is refused whole, and older marks keep their room first.
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
  /** Its cover failed to arrive; a refresh fetches it again. */
  coverMissing: boolean;
}

export interface OfflineRefusal {
  key: string;
  /** What the mark's missing Tracks need. */
  neededBytes: number;
  /** What the cap leaves after everything kept and planned before this mark. */
  freeBytes: number;
}

export interface OfflineSyncPlan {
  /** Tracks not on the device, each once, oldest mark first, in play order. */
  downloads: OfflineManifestTrack[];
  /** Stored Tracks whose metadata version moved, or whose cover is missing: their audio stays. */
  refreshes: OfflineManifestTrack[];
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
  const refreshes = [...listed.values()].filter((track) => {
    const copy = storedById.get(track.trackId);
    return copy !== undefined && (copy.version !== track.version || copy.coverMissing);
  });

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
      (sum, track) => sum + (track.byteSize ?? 0),
      0,
    );
    if (usedBytes + neededBytes > input.capBytes) {
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

  return { downloads, refreshes, deletions, refusals };
}
