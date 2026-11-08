// Mock storage provider — tests/dev only. It is the real `localFsStorageProvider`
// rooted at a fresh OS temp directory, so callers get a fully working, isolated
// store with a `cleanup()` to remove it. Not user-facing.

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localFsStorageProvider } from './local-fs';
import type { StorageProvider } from './index';

export interface MockStorage {
  provider: StorageProvider;
  /** The temp directory the mock is confined to. */
  dataRoot: string;
  /** Remove the temp directory and everything in it. */
  cleanup(): Promise<void>;
}

export function createMockStorageProvider(readUrlBase?: string): MockStorage {
  const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'liedmotif-mock-storage-'));
  const provider = localFsStorageProvider({
    dataRoot,
    ...(readUrlBase ? { readUrlBase } : {}),
  });
  return {
    provider,
    dataRoot,
    cleanup: () => rm(dataRoot, { recursive: true, force: true }),
  };
}
