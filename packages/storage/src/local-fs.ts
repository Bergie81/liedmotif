// Local filesystem storage adapter — the default `StorageProvider`.
//
// Every object lives under a single data root (the mounted `/data` volume). Keys
// are confined to the root two ways: a lexical check (`resolveObjectPath`, which
// rejects `..`/absolute/etc. keys) and a symlink re-check (`assertWithinRoot`,
// which resolves the nearest real ancestor so a symlink planted in the volume
// cannot redirect an operation outside it). The volume is app-owned and this
// adapter never creates symlinks; the second check guards a tampered volume.
//
// Writes are atomic (temp file + rename) so a failed or partial download never
// leaves a truncated object that the cold-start ladder could later serve as the
// "final" file — and durable: the temp file is fsynced before the rename and the
// ancestor directories after it, so a power loss cannot leave a zero-length
// "final" object (or lose a freshly created directory chain) at the destination
// key. Reads return streams (optionally a byte range) so large audio
// files are never buffered whole. `createReadUrl` returns an app-routed path —
// filesystem and provider paths never reach the browser; the HTTP route that
// streams these bytes with Range support lives in the web app.

import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat as fsStat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { contentTypeForKey } from './content-type';
import { appRoutedReadUrl, resolveReadUrlBase } from './read-url';
import { resolveObjectPath, StorageKeyError } from './safe-key';
import type {
  ReadStreamOptions,
  StorageObjectStat,
  StorageObjectWithStream,
  StorageProvider,
  WriteObjectInput,
} from './index';

export interface LocalFsStorageOptions {
  /** Root directory every object is confined to (the `/data` volume, `DATA_DIR`). */
  dataRoot: string;
  /** Base path for app-routed read URLs. Defaults to `/api/files`. */
  readUrlBase?: string;
}

/** Random bytes in a staged write's name — enough that concurrent writes to one
 *  key never collide, and short enough to stay well inside `NAME_MAX`. */
const TEMP_SUFFIX_BYTES = 6;

/** What a staged write is named, and so what the sweep is allowed to unlink.
 *  Deliberately anchored on the random middle: a stored object whose own key
 *  happens to end in `.tmp` must never match. */
const TEMP_FILE_PATTERN = new RegExp(`\\.[0-9a-f]{${TEMP_SUFFIX_BYTES * 2}}\\.tmp$`);

/** `fsync` a directory so a just-renamed entry in it survives power loss. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The adapter's one description of a stored object, from an already-taken `stat`. */
function describeFile(key: string, stats: Stats, mimeType?: string): StorageObjectStat {
  return {
    key,
    byteSize: stats.size,
    mimeType: mimeType ?? contentTypeForKey(key),
    updatedAt: stats.mtime,
  };
}

/** `realpath`, returning `undefined` for a path that does not exist yet. */
async function realpathIfExists(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function localFsStorageProvider(options: LocalFsStorageOptions): StorageProvider {
  const dataRoot = path.resolve(options.dataRoot);
  const readUrlBase = resolveReadUrlBase(options.readUrlBase);

  // The data root's resolution is stable for the provider's lifetime (a mounted
  // volume); every byte-serving operation re-checks its TARGET below, but the
  // root itself needs one realpath, not one per request. Never caches "absent",
  // so a root created later is still picked up.
  let cachedRealRoot: string | undefined;

  /**
   * Resolve symlinks on the nearest existing ancestor of `absolute` (walking up
   * to, but never past, the data root) and verify it still resolves inside the
   * root. If neither the target nor any ancestor up to the root exists yet, there
   * is nothing to escape through, so the caller may create them fresh.
   */
  async function assertWithinRoot(absolute: string): Promise<void> {
    const realRoot = (cachedRealRoot ??= await realpathIfExists(dataRoot));
    if (realRoot === undefined) return; // root not created yet → fresh tree, no symlinks
    let probe = absolute;
    for (;;) {
      const real = await realpathIfExists(probe);
      if (real !== undefined) {
        const relative = path.relative(realRoot, real);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new StorageKeyError();
        }
        return;
      }
      if (probe === dataRoot) return;
      probe = path.dirname(probe);
    }
  }

  /**
   * fsync `leaf` and each ancestor directory up to the data root, so a
   * just-renamed entry — and any directories `mkdir` freshly created for it —
   * survive power loss. Confinement guarantees the walk reaches the data root;
   * the filesystem-root check is a backstop against looping forever if it ever
   * did not.
   */
  async function syncAncestorDirectories(leaf: string): Promise<void> {
    for (let dir = leaf; ; dir = path.dirname(dir)) {
      await syncDirectory(dir);
      if (dir === dataRoot || dir === path.dirname(dir)) return;
    }
  }

  /**
   * Resolve a key to its confined absolute path: the lexical traversal check
   * (`resolveObjectPath`) followed by the symlink re-check (`assertWithinRoot`).
   * Every operation routes through this so confinement is applied identically.
   */
  async function resolveConfinedPath(key: string): Promise<string> {
    const absolute = resolveObjectPath(dataRoot, key);
    await assertWithinRoot(absolute);
    return absolute;
  }

  /**
   * Remove empty object directories without removing the data root. `ENOENT` is
   * expected when concurrent sibling deletions race to prune the same directory.
   */
  async function pruneEmptyAncestors(leaf: string): Promise<void> {
    for (let dir = leaf; dir !== dataRoot; dir = path.dirname(dir)) {
      try {
        await rmdir(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return;
        throw err;
      }
    }
  }

  async function buildStat(
    key: string,
    absolute: string,
    mimeType?: string,
  ): Promise<StorageObjectStat> {
    return describeFile(key, await fsStat(absolute), mimeType);
  }

  return {
    providerKey: 'local-fs',

    /** Free space on the volume the data root lives on, measured per call. */
    async freeBytes(): Promise<number> {
      const stats = await statfs(dataRoot);
      // `bavail` (available to unprivileged users), not `bfree`: the reserved
      // blocks root keeps back are not room this process can write into.
      return stats.bavail * stats.bsize;
    },

    async write(input: WriteObjectInput): Promise<StorageObjectStat> {
      const absolute = await resolveConfinedPath(input.key);
      await mkdir(path.dirname(absolute), { recursive: true });
      // Write to a sibling temp file, then atomically rename into place, so a
      // failed body never leaves a partial object and concurrent readers never
      // observe a half-written file. `flush: true` fsyncs the temp file before
      // it closes, so the rename publishes fully-durable bytes.
      const temp = `${absolute}.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`;
      try {
        if (input.body instanceof Uint8Array) {
          await writeFile(temp, input.body, { flush: true });
        } else {
          await pipeline(input.body, createWriteStream(temp, { flush: true }));
        }
        await rename(temp, absolute);
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
      await syncAncestorDirectories(path.dirname(absolute));
      return buildStat(input.key, absolute, input.mimeType);
    },

    async readStream(key: string, range?: ReadStreamOptions): Promise<Readable> {
      const absolute = await resolveConfinedPath(key);
      // Reject a missing object (ENOENT) or a directory key up front, rather than
      // letting `createReadStream` emit a deferred 'error' on a half-opened stream.
      const stats = await fsStat(absolute);
      if (!stats.isFile()) throw new StorageKeyError('Storage key does not address a file');
      return createReadStream(absolute, { start: range?.start, end: range?.end });
    },

    async readStreamWithStat(
      key: string,
      range?: ReadStreamOptions,
    ): Promise<StorageObjectWithStream | null> {
      const absolute = await resolveConfinedPath(key);
      // One open + one fstat: the stream reads from the same handle, so the
      // stat can never describe different bytes than the stream delivers.
      const handle = await open(absolute, 'r').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (!handle) return null;
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new StorageKeyError('Storage key does not address a file');
        return {
          stream: handle.createReadStream({ start: range?.start, end: range?.end }),
          stat: describeFile(key, stats),
        };
      } catch (err) {
        // `close()` throws SYNCHRONOUSLY on a handle whose stream creation just
        // failed, so the cleanup is guarded in full: the caller must see the
        // failure that actually matters, never the cleanup's.
        try {
          await handle.close();
        } catch {
          /* the original error is the one worth reporting */
        }
        throw err;
      }
    },

    async delete(key: string): Promise<void> {
      const absolute = await resolveConfinedPath(key);
      await rm(absolute, { force: true });
      await pruneEmptyAncestors(path.dirname(absolute));
    },

    async stat(key: string): Promise<StorageObjectStat | null> {
      const absolute = await resolveConfinedPath(key);
      try {
        return await buildStat(key, absolute);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    /**
     * Unlink the staged writes a SIGKILL, OOM, or container restart stranded —
     * the one class of object no key addresses and no deleter can reach.
     *
     * Confinement here is structural rather than re-checked: the walk starts at
     * the data root and descends only through directory entries `readdir`
     * reports as real directories, so a symlink planted in the volume is never
     * followed and the walk cannot leave the root. Unlinking is likewise limited
     * to regular files matching the staged-write name.
     */
    async sweepInterruptedWrites(olderThan: Date): Promise<number> {
      let removed = 0;
      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(absolute);
            continue;
          }
          if (!entry.isFile() || !TEMP_FILE_PATTERN.test(entry.name)) continue;
          // A write staged since the cutoff may still be in flight; only its own
          // `rename` or error path may touch it.
          const stats = await lstat(absolute).catch(() => null);
          if (!stats || stats.mtime >= olderThan) continue;
          await rm(absolute, { force: true });
          removed += 1;
        }
      }
      await walk(dataRoot);
      return removed;
    },

    async createReadUrl(key: string): Promise<string> {
      return appRoutedReadUrl(readUrlBase, key); // validates; never exposes a filesystem path
    },
  };
}
