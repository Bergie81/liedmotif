// The offline sync runner: keeps this device's Available-offline copy in step
// with the server while online, in the foreground. A sync reads every marked
// collection's manifest, plans against what the device holds
// (`planOfflineSync`), deletes what no mark lists, then fetches what is missing
// one Track at a time. A Track lands whole or not at all, so a sync cut short —
// by the network, a closed tab, or a mark change — resumes on the next one with
// the Tracks it did not finish. A sync that heard every manifest is recorded as
// the device's last successful one, which Lounge copies expire from.
//
// At most one sync runs at a time. A request during a run queues one more run,
// so a change made mid-sync is never missed. Marking, unmarking, clearing,
// changing the cap, claiming and wiping first stop the running sync, so it can
// never write behind them. Unmarking, clearing and wiping also void a mark
// still waiting for the server's answer, which would otherwise land after them.

import type {
  OfflineManifest,
  OfflineManifestTrack,
  TrackDetails,
  TrackLyrics,
} from '@liedmotif/shared';
import { planOfflineSync, type OfflineRefusal, type StoredTrack } from './offline-sync-plan';
import {
  offlineMarkKey,
  type OfflineMark,
  type OfflineMarkKind,
  type OfflineStore,
  type OfflineTrackCopy,
  type OfflineTrackInput,
} from './offline-store';

/** The cap a device keeps until it sets its own in Settings → Storage. */
export const DEFAULT_OFFLINE_CAP_BYTES = 5 * 1024 ** 3;

/** The server reads a sync makes. Each throws when the server cannot answer. */
export interface OfflineServer {
  /** The collection's manifest, or `gone` when the server has no such collection for this User. */
  manifest(
    mark: { kind: OfflineMarkKind; id: string },
    signal: AbortSignal,
  ): Promise<OfflineManifest | 'gone'>;
  audio(trackId: string, signal: AbortSignal): Promise<Blob>;
  cover(coverImageId: string, signal: AbortSignal): Promise<Blob>;
  details(trackId: string, signal: AbortSignal): Promise<TrackDetails>;
  lyrics(trackId: string, signal: AbortSignal): Promise<TrackLyrics>;
}

export type OfflineMarkStatus =
  | { state: 'downloading'; done: number; total: number }
  /** Incomplete with no sync running: the next sync carries on. */
  | { state: 'paused'; done: number; total: number }
  | { state: 'ready'; total: number }
  /** The collection has no Tracks, so there is nothing to call whole. */
  | { state: 'empty' }
  | { state: 'refused'; neededBytes: number; freeBytes: number };

export type OfflineMarkResult = { marked: true } | { marked: false; refusal: OfflineRefusal };

export type OfflineCapResult = { set: true } | { set: false; usedBytes: number };

export interface OfflineSync {
  /** Brings every mark up to date; never rejects — an unreachable server waits for the next sync. */
  sync(): Promise<void>;
  /** Resolves once no sync is running. */
  settled(): Promise<void>;
  /** Marks a collection, or refuses it when its Tracks would go over the cap. Throws when the
   *  server cannot answer, or when an unmark, clear or wipe came while it waited for the answer. */
  mark(kind: OfflineMarkKind, id: string): Promise<OfflineMarkResult>;
  /** Unmarks a collection and frees its Tracks no other mark lists, without the server. */
  unmark(kind: OfflineMarkKind, id: string): Promise<void>;
  /** Unmarks every collection and frees every Track; the store stays the signed-in User's. */
  clear(): Promise<void>;
  /** Changes the device's cap, or refuses one below what it already holds: nothing is evicted to fit. */
  setCap(bytes: number): Promise<OfflineCapResult>;
  /** Every mark, every stored Track's copy and the cap, as the device holds them now. */
  contents(): Promise<{ marks: OfflineMark[]; copies: OfflineTrackCopy[]; capBytes: number }>;
  /** Hands the device store to this User, emptying it if it held someone else's music. */
  claim(userId: string): Promise<void>;
  wipe(): Promise<void>;
  /** Per mark key; replaced, never mutated, on every change. */
  status(): ReadonlyMap<string, OfflineMarkStatus>;
  subscribe(listener: () => void): () => void;
}

function storedTrack(copy: OfflineTrackCopy): StoredTrack {
  return {
    trackId: copy.trackId,
    version: copy.version,
    bytes: copy.audioBytes + copy.coverBytes,
    coverMissing: copy.track.coverImageId !== null && copy.coverBytes === 0,
  };
}

export function createOfflineSync(deps: {
  store: OfflineStore;
  server: OfflineServer;
  /** The cap until this device sets its own. */
  capBytes: number;
  now?: () => number;
  /** Asks the browser to keep the store; called when the first mark is set. */
  persist?: () => void;
}): OfflineSync {
  const { store, server } = deps;
  const now = deps.now ?? Date.now;
  // Read at every decision, so a cap set in another tab holds here too.
  const capBytes = async () => (await store.cap()) ?? deps.capBytes;
  let running: { controller: AbortController; done: Promise<void> } | null = null;
  let rerun = false;
  /** Moves on every unmark, clear and wipe; a mark decided across a move is void. */
  let generation = 0;
  let refusals = new Map<string, OfflineRefusal>();
  let status: ReadonlyMap<string, OfflineMarkStatus> = new Map();
  const listeners = new Set<() => void>();

  function publish(marks: readonly OfflineMark[], held: ReadonlySet<string>, active: boolean) {
    status = new Map(
      marks.map((mark): [string, OfflineMarkStatus] => {
        const { tracks, leftOutTrackCount } = mark.manifest;
        const total = tracks.length + (leftOutTrackCount ?? 0);
        const done = tracks.filter((entry) => held.has(entry.trackId)).length;
        const refusal = refusals.get(mark.key);
        if (refusal) {
          return [
            mark.key,
            { state: 'refused', neededBytes: refusal.neededBytes, freeBytes: refusal.freeBytes },
          ];
        }
        if (total === 0) return [mark.key, { state: 'empty' }];
        // A mark last synced by an older app has no count until its next sync, so
        // what it left out is unknown and the copy cannot be called whole.
        if (done === total && leftOutTrackCount !== undefined) {
          return [mark.key, { state: 'ready', total }];
        }
        return [mark.key, { state: active ? 'downloading' : 'paused', done, total }];
      }),
    );
    for (const listener of listeners) listener();
  }

  /** Plans `marks` against what the device holds now and its cap. */
  async function planStored(marks: readonly OfflineMark[]) {
    return planOfflineSync({
      marks,
      stored: (await store.list()).map(storedTrack),
      capBytes: await capBytes(),
    });
  }

  async function publishStored() {
    const [marks, copies] = await Promise.all([store.marks(), store.list()]);
    publish(marks, new Set(copies.map((copy) => copy.trackId)), running !== null);
  }

  async function fetchCopy(
    entry: OfflineManifestTrack,
    withAudio: boolean,
    signal: AbortSignal,
    covers: Map<string, Promise<Blob | null>>,
  ): Promise<OfflineTrackInput> {
    const audio = withAudio ? await server.audio(entry.trackId, signal) : undefined;
    const details = await server.details(entry.trackId, signal);
    const lyrics =
      entry.vocalMode === 'vocal' && entry.hasLyrics
        ? await server.lyrics(entry.trackId, signal)
        : null;
    // Art is cosmetic: a cover that will not load leaves the Track playable
    // without it, and the next sync asks for it again.
    let cover: Promise<Blob | null> | null = null;
    if (entry.coverImageId) {
      const coverImageId = entry.coverImageId;
      cover = covers.get(coverImageId) ?? server.cover(coverImageId, signal).catch(() => null);
      covers.set(coverImageId, cover);
    }
    return {
      trackId: entry.trackId,
      version: entry.version,
      track: entry,
      details,
      lyrics,
      ...(audio ? { audio } : {}),
      cover: cover ? await cover : null,
    };
  }

  async function syncOnce(signal: AbortSignal): Promise<void> {
    const fresh: OfflineMark[] = [];
    for (const mark of await store.marks()) {
      const manifest = await server.manifest(mark, signal);
      if (signal.aborted) return;
      if (manifest === 'gone') await store.deleteMark(mark.key);
      else fresh.push({ ...mark, manifest });
    }
    const copies = await store.list();
    const plan = planOfflineSync({
      marks: fresh,
      stored: copies.map(storedTrack),
      capBytes: await capBytes(),
    });
    await store.delete(plan.deletions);
    // Another tab may unmark or clear while this sync runs; only marks still
    // stored are written back, so a removal there is never undone here.
    const stillMarked = async () => new Set((await store.marks()).map((mark) => mark.key));
    let marked = await stillMarked();
    for (const mark of fresh) if (marked.has(mark.key)) await store.putMark(mark);
    await store.putLastSyncedAt(now());
    refusals = new Map(plan.refusals.map((refusal) => [refusal.key, refusal]));

    const deleted = new Set(plan.deletions);
    const held = new Set(copies.map((copy) => copy.trackId).filter((id) => !deleted.has(id)));
    publish(fresh, held, true);

    const covers = new Map<string, Promise<Blob | null>>();
    const work = [
      ...plan.downloads.map((entry) => ({ entry, withAudio: true })),
      ...plan.refreshes.map((entry) => ({ entry, withAudio: false })),
    ];
    for (const { entry, withAudio } of work) {
      if (signal.aborted) return;
      try {
        const copy = await fetchCopy(entry, withAudio, signal, covers);
        if (signal.aborted) return;
        await store.put(copy);
        held.add(entry.trackId);
        publish(fresh, held, true);
      } catch {
        // Left for the next sync, which plans this Track again.
      }
    }

    const syncedAt = now();
    marked = await stillMarked();
    for (const mark of fresh) {
      const complete = mark.manifest.tracks.every((entry) => held.has(entry.trackId));
      if (complete && !refusals.has(mark.key) && marked.has(mark.key)) {
        await store.putMark({ ...mark, syncedAt });
      }
    }
  }

  function sync(): Promise<void> {
    if (running) {
      rerun = true;
      return running.done;
    }
    const controller = new AbortController();
    const done = (async () => {
      try {
        do {
          rerun = false;
          await syncOnce(controller.signal);
        } while (rerun && !controller.signal.aborted);
      } catch {
        // Unreachable server or storage: nothing was half-written, the next sync retries.
      } finally {
        running = null;
        if (!controller.signal.aborted) await publishStored().catch(() => undefined);
      }
    })();
    running = { controller, done };
    return done;
  }

  async function interrupt(): Promise<void> {
    if (!running) return;
    running.controller.abort();
    await running.done;
  }

  /** Keeps the mark unless its missing Tracks would go over the cap, judged
   *  against every other mark's last-known Tracks before anything downloads.
   *  `markedIn` is the generation the mark was asked in. */
  async function decideMark(
    kind: OfflineMarkKind,
    id: string,
    markedIn: number,
  ): Promise<OfflineMarkResult> {
    const key = offlineMarkKey(kind, id);
    const manifest = await server.manifest({ kind, id }, new AbortController().signal);
    if (manifest === 'gone') throw new Error('This collection is no longer available.');
    const others = (await store.marks()).filter((mark) => mark.key !== key);
    const candidate: OfflineMark = { key, kind, id, markedAt: now(), syncedAt: null, manifest };
    const plan = await planStored([...others, candidate]);
    const refusal = plan.refusals.find((entry) => entry.key === key);
    if (refusal) return { marked: false, refusal };
    if (generation !== markedIn) throw new Error('An unmark, clear or wipe came first.');
    await store.putMark(candidate);
    if (others.length === 0) deps.persist?.();
    return { marked: true };
  }

  return {
    sync,

    settled: () => running?.done ?? Promise.resolve(),

    async mark(kind, id) {
      const markedIn = generation;
      await interrupt();
      let result: OfflineMarkResult;
      try {
        result = await decideMark(kind, id, markedIn);
      } finally {
        void sync();
      }
      if (result.marked) await publishStored();
      return result;
    },

    async unmark(kind, id) {
      generation += 1;
      await interrupt();
      const key = offlineMarkKey(kind, id);
      await store.deleteMark(key);
      refusals.delete(key);
      const plan = await planStored(await store.marks());
      await store.delete(plan.deletions);
      await publishStored();
      void sync();
    },

    async clear() {
      generation += 1;
      await interrupt();
      for (const mark of await store.marks()) await store.deleteMark(mark.key);
      await store.delete((await store.list()).map((copy) => copy.trackId));
      refusals = new Map();
      publish([], new Set(), false);
    },

    async setCap(bytes) {
      await interrupt();
      try {
        const usedBytes = await store.usage();
        if (bytes < usedBytes) return { set: false, usedBytes };
        await store.putCap(bytes);
        return { set: true };
      } finally {
        void sync();
      }
    },

    async contents() {
      const [marks, copies, cap] = await Promise.all([store.marks(), store.list(), capBytes()]);
      return { marks, copies, capBytes: cap };
    },

    async claim(userId) {
      await interrupt();
      await store.claim(userId);
      refusals = new Map();
      await publishStored();
    },

    async wipe() {
      generation += 1;
      await interrupt();
      await store.wipe();
      refusals = new Map();
      publish([], new Set(), false);
    },

    status: () => status,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
