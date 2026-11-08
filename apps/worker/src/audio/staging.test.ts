// Staging: storage → temp file, with the input guards (size cap,
// temp-disk headroom) and guaranteed cleanup.

import { access, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockStorageProvider, type MockStorage } from '@liedmotif/storage';
import { AnalysisInputError, AnalysisResourceError } from './errors';
import { MAX_ANALYSIS_INPUT_BYTES, stageAnalysisAudio } from './staging';

let mock: MockStorage | null = null;
afterEach(async () => {
  await mock?.cleanup();
  mock = null;
});

async function storageWith(key: string, bytes: Buffer): Promise<MockStorage> {
  mock = createMockStorageProvider();
  await mock.provider.write({ key, body: bytes });
  return mock;
}

describe('stageAnalysisAudio', () => {
  it('stages the object to a temp file and cleanup removes it', async () => {
    const bytes = Buffer.from('liedmotif-audio-bytes');
    const { provider } = await storageWith('tracks/u/t.mp3', bytes);

    const staged = await stageAnalysisAudio(provider, 'tracks/u/t.mp3');
    expect(await readFile(staged.path)).toEqual(bytes);

    await staged.cleanup();
    await expect(access(staged.path)).rejects.toThrow();
    // Idempotent — the analyzer calls it in `finally` even after early cleanup.
    await staged.cleanup();
  });

  it('throws for an object missing from storage WITHOUT echoing the key', async () => {
    // Storage keys carry Session/Track title slugs (user-intent-derived) —
    // staging errors go to logs/last_error and must never include them.
    mock = createMockStorageProvider();
    const failure = await stageAnalysisAudio(
      mock.provider,
      'tracks/u/secret-breakup-session/gone.mp3',
    ).then(
      () => null,
      (err: Error) => err,
    );
    expect(failure?.message).toMatch(/missing from storage/);
    expect(failure?.message).not.toContain('secret-breakup-session');
  });

  it('rejects an oversize input as a PERMANENT failure before moving bytes', async () => {
    const { provider } = await storageWith('tracks/u/big.mp3', Buffer.from('tiny'));
    const oversizedStat = {
      ...provider,
      stat: async (key: string) => {
        const real = await provider.stat(key);
        return real ? { ...real, byteSize: MAX_ANALYSIS_INPUT_BYTES + 1 } : null;
      },
    };
    await expect(stageAnalysisAudio(oversizedStat, 'tracks/u/big.mp3')).rejects.toBeInstanceOf(
      AnalysisInputError,
    );
  });

  it('refuses to stage without temp-disk headroom as a RESOURCE error (retryable, never failed)', async () => {
    const { provider } = await storageWith('tracks/u/t.mp3', Buffer.from('bytes'));
    await expect(
      stageAnalysisAudio(provider, 'tracks/u/t.mp3', { freeBytes: async () => 1024 }),
    ).rejects.toBeInstanceOf(AnalysisResourceError);
  });

  it('cleans up on a mid-stream failure and rethrows SANITIZED (no paths, no key)', async () => {
    const { provider } = await storageWith('tracks/u/my-private-vibe.mp3', Buffer.from('bytes'));
    const failingRead = {
      ...provider,
      readStream: async () =>
        new Readable({
          read() {
            const err = new Error('EIO: read /data/tracks/u/my-private-vibe.mp3 failed');
            (err as NodeJS.ErrnoException).code = 'EIO';
            this.destroy(err);
          },
        }),
    };
    const failure = await stageAnalysisAudio(failingRead, 'tracks/u/my-private-vibe.mp3').then(
      () => null,
      (err: Error) => err,
    );
    expect(failure?.message).toMatch(/staging copy failed \(EIO\)/);
    expect(failure?.message).not.toContain('my-private-vibe');
    expect(failure?.message).not.toContain('/data');
  });

  it('a NEVER-settling readStream times out inside staging and leaves no temp dir behind', async () => {
    // The caller's deadline race cannot clean a temp dir it never received a
    // handle to — staging itself must own the acquisition timeout.
    const { provider } = await storageWith('tracks/u/t.mp3', Buffer.from('bytes'));
    const before = (await readdir(tmpdir())).filter((d) => d.startsWith('liedmotif-analysis-'));
    const hung = { ...provider, readStream: () => new Promise<never>(() => {}) };
    await expect(
      stageAnalysisAudio(hung as never, 'tracks/u/t.mp3', { timeoutMs: 150 }),
    ).rejects.toThrow(/StagingReadTimeout|staging copy failed/);
    const after = (await readdir(tmpdir())).filter((d) => d.startsWith('liedmotif-analysis-'));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  it('maps OS resource exhaustion (ENOSPC & friends) to a RESOURCE error, not a permanent failure', async () => {
    const { provider } = await storageWith('tracks/u/t.mp3', Buffer.from('bytes'));
    const noSpace = {
      ...provider,
      readStream: async () => {
        const err = new Error('ENOSPC: no space left on device');
        (err as NodeJS.ErrnoException).code = 'ENOSPC';
        throw err;
      },
    };
    await expect(stageAnalysisAudio(noSpace, 'tracks/u/t.mp3')).rejects.toBeInstanceOf(
      AnalysisResourceError,
    );
  });
});
