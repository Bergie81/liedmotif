import type { StorageProvider } from '@liedmotif/storage';
import { execFileFfmpegRunner, FFMPEG_PASS_TIMEOUT_MS } from './ffmpeg';
import { stageAnalysisAudio } from './staging';

/** One byte per sample: counting decoded bytes at this rate is the duration. */
const DURATION_SAMPLE_RATE = 8000;
/** stdout bound: ~2.3 hours of 8 kHz mono u8. */
const DURATION_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Decode the complete local audio; a missing container duration never becomes a guess. */
export async function measureAudioDuration(path: string): Promise<number> {
  const { stdout } = await execFileFfmpegRunner(
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      String(DURATION_SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      'u8',
      'pipe:1',
    ],
    { timeoutMs: FFMPEG_PASS_TIMEOUT_MS, maxBufferBytes: DURATION_MAX_BUFFER_BYTES },
  );
  const seconds = stdout.length / DURATION_SAMPLE_RATE;
  if (seconds <= 0) {
    throw new Error('Audio duration could not be measured');
  }
  return seconds;
}

export async function measureStoredAudioDuration(
  storage: StorageProvider,
  storageKey: string,
): Promise<number> {
  const staged = await stageAnalysisAudio(storage, storageKey);
  try {
    return await measureAudioDuration(staged.path);
  } finally {
    await staged.cleanup();
  }
}
