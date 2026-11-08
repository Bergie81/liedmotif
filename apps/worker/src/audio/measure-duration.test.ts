import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileFfmpegRunner, isFfmpegAvailable } from './ffmpeg';
import { measureAudioDuration } from './measure-duration';

const available = await isFfmpegAvailable();

describe.skipIf(!available)('audio duration measurement', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duration-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('measures complete audio when provider duration is absent', async () => {
    const path = join(dir, 'fixture.wav');
    await execFileFfmpegRunner(['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2.5', path], {
      timeoutMs: 5000,
      maxBufferBytes: 1024 * 1024,
    });
    expect(await measureAudioDuration(path)).toBeCloseTo(2.5, 2);
  });

  it('refuses unavailable audio instead of inventing a duration', async () => {
    await expect(measureAudioDuration(join(dir, 'missing.wav'))).rejects.toThrow();
  });
});
