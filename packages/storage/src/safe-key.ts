// Storage-key safety. Object keys are app-generated, but they may embed
// user-derived ids (ownerUserId, coverId). This module is the single gate that
// keeps a key from escaping the `/data` volume root via path traversal —
// `..`, absolute paths, backslashes, null bytes, home/drive prefixes. Every
// filesystem operation resolves through `resolveObjectPath` so confinement is
// enforced in one place, not re-derived at each call site.

import path from 'node:path';

/** Thrown when a storage key is unsafe (traversal / escape attempt). */
export class StorageKeyError extends Error {
  constructor(message = 'Unsafe storage key') {
    super(message);
    this.name = 'StorageKeyError';
  }
}

const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/**
 * Validate a storage key syntactically and return it unchanged. Rejects anything
 * that could resolve outside the data root: absolute paths, `..`/`.` segments,
 * backslashes, null bytes, empty segments (leading/trailing/double slash), and
 * home/Windows-drive prefixes. Keys are always forward-slash, root-relative.
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) throw new StorageKeyError();
  if (key.includes('\0')) throw new StorageKeyError();
  if (key.includes('\\')) throw new StorageKeyError();
  if (key.startsWith('/')) throw new StorageKeyError();
  if (key.startsWith('~')) throw new StorageKeyError();
  if (WINDOWS_DRIVE.test(key)) throw new StorageKeyError();

  for (const segment of key.split('/')) {
    // Empty (`//`, leading/trailing slash), current-dir, and parent-dir segments
    // are all refused so the key maps to exactly one normalized path.
    if (segment === '' || segment === '.' || segment === '..') {
      throw new StorageKeyError();
    }
  }
  return key;
}

/**
 * Resolve a safe key to an absolute filesystem path inside `dataRoot`. Belt and
 * suspenders: after the syntactic `assertSafeKey` check, the resolved path is
 * re-verified to be contained in the root, so any future gap in the syntactic
 * check still cannot escape.
 */
export function resolveObjectPath(dataRoot: string, key: string): string {
  assertSafeKey(key);
  const root = path.resolve(dataRoot);
  const absolute = path.resolve(root, key);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StorageKeyError();
  }
  return absolute;
}
