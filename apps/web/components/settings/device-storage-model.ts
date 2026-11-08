// What Settings → Storage shows of this device's offline music: how much it
// holds, each offline collection with its size, and whether offline is
// possible on this page at all. Everything here is this browser's, never the
// server's.

import type { OfflineMark, OfflineMarkKind, OfflineTrackCopy } from '@/lib/offline/offline-store';

/** One collection marked Available offline, sized by its Tracks on the device. */
export interface DeviceStorageItem {
  key: string;
  kind: OfflineMarkKind;
  id: string;
  name: string;
  bytes: number;
}

const storedBytes = (copy: OfflineTrackCopy) => copy.audioBytes + copy.coverBytes;

/** A Track two collections list is stored once: it counts once in `usedBytes`,
 *  and in the size of each collection, since removing either alone frees none of it. */
export function deviceStorage(
  marks: readonly OfflineMark[],
  copies: readonly OfflineTrackCopy[],
): { usedBytes: number; items: DeviceStorageItem[] } {
  const held = new Map(copies.map((copy) => [copy.trackId, storedBytes(copy)]));
  return {
    usedBytes: copies.reduce((sum, copy) => sum + storedBytes(copy), 0),
    items: marks
      .map((mark) => ({
        key: mark.key,
        kind: mark.kind,
        id: mark.id,
        name: mark.manifest.name,
        bytes: mark.manifest.tracks.reduce((sum, track) => sum + (held.get(track.trackId) ?? 0), 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const GIB = 1024 ** 3;

/** What the cap can be set to: few enough steps that any is a tap or two away. */
const CAP_CHOICES = [1, 2, 5, 10, 20, 50].map((gib) => gib * GIB);

/** The cap choice after this one, or null at either end. */
export function nextCapStep(capBytes: number, direction: 'up' | 'down'): number | null {
  const next =
    direction === 'up'
      ? CAP_CHOICES.find((choice) => choice > capBytes)
      : CAP_CHOICES.findLast((choice) => choice < capBytes);
  return next ?? null;
}

export type OfflineAvailability =
  | { kind: 'available' }
  /** `secureAddress`: the instance's own HTTPS address, when it has one. */
  | { kind: 'needs-https'; secureAddress: string | null }
  /** A secure page that offers no offline storage (a browser without IndexedDB). */
  | { kind: 'unavailable' };

/** Offline storage needs a secure context. A page opened over plain HTTP, say
 *  at a LAN address, points to the instance's public URL when that is HTTPS. */
export function offlineAvailability(
  page: { secureContext: boolean; supported: boolean },
  publicUrl: string,
): OfflineAvailability {
  if (page.supported) return { kind: 'available' };
  if (page.secureContext) return { kind: 'unavailable' };
  return {
    kind: 'needs-https',
    secureAddress: /^https:\/\//i.test(publicUrl) ? publicUrl : null,
  };
}

/** iOS may clear a Safari tab's storage after about a week without use; a Home
 *  Screen app keeps it. iPadOS Safari reports itself as a Mac, so a Mac
 *  user agent with a touch screen counts as an iPad. */
export function needsHomeScreenHint(device: {
  userAgent: string;
  maxTouchPoints: number;
  /** Running as a Home Screen app. */
  standalone: boolean;
}): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(device.userAgent) ||
    (/Macintosh/.test(device.userAgent) && device.maxTouchPoints > 1);
  return ios && !device.standalone;
}
