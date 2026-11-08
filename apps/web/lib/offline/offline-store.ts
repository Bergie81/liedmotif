// The device's offline store: every Available-offline Track this browser holds
// — the audio exactly as `/api/audio/<id>` served it, its cover, and what the
// Player shows besides (presentation, Track Data, lyrics) — plus the marks that
// keep them here, when a sync last confirmed them, and the device's cap on all
// of it. It belongs to one User at a time: claiming it for anyone else empties
// it first, so a shared device never plays one account's music to another; the
// cap, a setting of the device rather than of a User, stays. A store writes
// only while the device still belongs to the User it claimed it for: once it
// is wiped at sign-out or claimed for someone else in another tab, a sync
// still running here cannot put the earlier User's music back.
//
// The store is the logic; a backing is the storage engine under it (IndexedDB
// in the browser, `openIndexedDbBacking`). Bytes and metadata live apart, so
// listing what is stored never reads audio.

import type {
  OfflineManifest,
  OfflineManifestTrack,
  TrackDetails,
  TrackLyrics,
} from '@liedmotif/shared';

export type OfflineBackingStore = 'tracks' | 'files' | 'marks' | 'meta';

/** One keyed write; an `undefined` value deletes the key. */
export interface OfflineBackingWrite {
  store: OfflineBackingStore;
  key: string;
  value: unknown;
}

export interface OfflineBacking {
  get(store: OfflineBackingStore, key: string): Promise<unknown>;
  getAll(store: OfflineBackingStore): Promise<unknown[]>;
  /** Applies every write or none. */
  write(writes: readonly OfflineBackingWrite[]): Promise<void>;
  /** Empties every store. */
  clear(): Promise<void>;
}

/** What is stored for one Track besides its bytes. */
export interface OfflineTrackCopy {
  trackId: string;
  /** The manifest version this copy's metadata was taken at. */
  version: string;
  track: OfflineManifestTrack;
  details: TrackDetails;
  /** Null for an instrumental Track. */
  lyrics: TrackLyrics | null;
  audioBytes: number;
  coverBytes: number;
}

export interface OfflineTrackInput {
  trackId: string;
  version: string;
  track: OfflineManifestTrack;
  details: TrackDetails;
  lyrics: TrackLyrics | null;
  /** Omitted on a metadata refresh: the stored audio stays. */
  audio?: Blob;
  cover: Blob | null;
}

export type OfflineMarkKind = 'playlist' | 'session';

/** A collection marked Available offline on this device. */
export interface OfflineMark {
  key: string;
  kind: OfflineMarkKind;
  id: string;
  markedAt: number;
  /** When a sync last brought this mark's Tracks fully up to date. */
  syncedAt: number | null;
  /** The collection as the server last answered it: its name and storable Tracks. */
  manifest: OfflineManifest;
}

export function offlineMarkKey(kind: OfflineMarkKind, id: string): string {
  return `${kind}:${id}`;
}

export type OfflineFile = 'audio' | 'cover';

export interface OfflineStore {
  /** Throws as {@link putMark} does. */
  put(input: OfflineTrackInput): Promise<void>;
  /** A stored file, or null. */
  getFile(trackId: string, file: OfflineFile): Promise<Blob | null>;
  /** A fresh object URL for a stored file, or null; the caller revokes it. */
  getObjectUrl(trackId: string, file: OfflineFile): Promise<string | null>;
  delete(trackIds: readonly string[]): Promise<void>;
  list(): Promise<OfflineTrackCopy[]>;
  /** Every stored byte, audio and covers. */
  usage(): Promise<number>;
  /** Empties the store: Tracks, files, marks and its owner. The cap stays. */
  wipe(): Promise<void>;
  marks(): Promise<OfflineMark[]>;
  /** Throws unless the device still belongs to the User this store claimed it for. */
  putMark(mark: OfflineMark): Promise<void>;
  deleteMark(key: string): Promise<void>;
  /** When a sync last heard every mark's manifest and deleted what they no
   *  longer list; null before the first. Lounge copies expire from it. */
  lastSyncedAt(): Promise<number | null>;
  /** Throws as {@link putMark} does. */
  putLastSyncedAt(at: number): Promise<void>;
  /** The most this device keeps offline, once set here; null until then. */
  cap(): Promise<number | null>;
  /** Throws as {@link putMark} does. */
  putCap(bytes: number): Promise<void>;
  /** Makes the store this User's, emptying it first (all but the cap) when it was anyone else's. */
  claim(userId: string): Promise<void>;
}

const OWNER_KEY = 'owner';
const LAST_SYNCED_KEY = 'lastSyncedAt';
const CAP_KEY = 'capBytes';

function fileKey(file: OfflineFile, trackId: string): string {
  return `${file}:${trackId}`;
}

export function createOfflineStore(backing: OfflineBacking): OfflineStore {
  /** The User this store last claimed the device for; other tabs claim through their own store. */
  let claimant: string | null = null;
  const list = async () => (await backing.getAll('tracks')) as OfflineTrackCopy[];

  async function getFile(trackId: string, file: OfflineFile): Promise<Blob | null> {
    const bytes = await backing.get('files', fileKey(file, trackId));
    return bytes instanceof Blob ? bytes : null;
  }

  /** Empties every store but the cap, which is this device's setting and not
   *  the User's music, then hands the store to `owner`, if any. */
  async function empty(owner?: string): Promise<void> {
    const cap = await backing.get('meta', CAP_KEY);
    await backing.clear();
    await backing.write([
      { store: 'meta', key: CAP_KEY, value: cap },
      ...(owner ? [{ store: 'meta' as const, key: OWNER_KEY, value: owner }] : []),
    ]);
  }

  async function claimed(): Promise<void> {
    if (claimant === null || (await backing.get('meta', OWNER_KEY)) !== claimant) {
      throw new Error('The offline store no longer belongs to the User who claimed it.');
    }
  }

  return {
    async put(input) {
      await claimed();
      const held = (await backing.get('tracks', input.trackId)) as OfflineTrackCopy | undefined;
      if (!input.audio && !held) {
        throw new Error('An offline Track needs its audio before its metadata can be refreshed.');
      }
      const copy: OfflineTrackCopy = {
        trackId: input.trackId,
        version: input.version,
        track: input.track,
        details: input.details,
        lyrics: input.lyrics,
        audioBytes: input.audio ? input.audio.size : held!.audioBytes,
        coverBytes: input.cover?.size ?? 0,
      };
      await backing.write([
        ...(input.audio
          ? [{ store: 'files' as const, key: fileKey('audio', input.trackId), value: input.audio }]
          : []),
        { store: 'files', key: fileKey('cover', input.trackId), value: input.cover ?? undefined },
        { store: 'tracks', key: input.trackId, value: copy },
      ]);
    },

    getFile,

    async getObjectUrl(trackId, file) {
      const bytes = await getFile(trackId, file);
      return bytes ? URL.createObjectURL(bytes) : null;
    },

    async delete(trackIds) {
      await backing.write(
        trackIds.flatMap((trackId) => [
          { store: 'tracks' as const, key: trackId, value: undefined },
          { store: 'files' as const, key: fileKey('audio', trackId), value: undefined },
          { store: 'files' as const, key: fileKey('cover', trackId), value: undefined },
        ]),
      );
    },

    list,

    async usage() {
      return (await list()).reduce((sum, copy) => sum + copy.audioBytes + copy.coverBytes, 0);
    },

    wipe: () => empty(),

    marks: async () => (await backing.getAll('marks')) as OfflineMark[],

    async putMark(mark) {
      await claimed();
      await backing.write([{ store: 'marks', key: mark.key, value: mark }]);
    },

    deleteMark: (key) => backing.write([{ store: 'marks', key, value: undefined }]),

    async lastSyncedAt() {
      const at = await backing.get('meta', LAST_SYNCED_KEY);
      return typeof at === 'number' ? at : null;
    },

    async putLastSyncedAt(at) {
      await claimed();
      await backing.write([{ store: 'meta', key: LAST_SYNCED_KEY, value: at }]);
    },

    async cap() {
      const bytes = await backing.get('meta', CAP_KEY);
      return typeof bytes === 'number' ? bytes : null;
    },

    async putCap(bytes) {
      await claimed();
      await backing.write([{ store: 'meta', key: CAP_KEY, value: bytes }]);
    },

    async claim(userId) {
      claimant = userId;
      if ((await backing.get('meta', OWNER_KEY)) === userId) return;
      await empty(userId);
    },
  };
}
