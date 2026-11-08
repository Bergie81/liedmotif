// MP3 decode-offset parity — the worker half.
//
// Worker anchors are measured on ffmpeg-decoded PCM; the player aligns
// `decodeAudioData`-decoded PCM. Both honor LAME/Xing gapless metadata, but the
// encoder-delay handling must be ASSERTED equal: a constant per-decoder offset
// would shift every anchor by the same amount and — unlike estimator bias — does
// NOT cancel across a media↔buffer mixed edge. This test pins the ffmpeg side to
// the recorded constant; `decodeAudioData` is pinned to the SAME constant in a
// real browser. Measured MP3 anchors must not activate alignment unless both
// pass.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePcmMono, isFfmpegAvailable } from './ffmpeg';
import { ESTIMATOR_SAMPLE_RATE } from './estimator';

const fixtureDir = join(import.meta.dirname, 'fixtures');
const expected = JSON.parse(
  readFileSync(join(fixtureDir, 'decode-parity-expected.json'), 'utf8'),
) as { anchorSeconds: number; thresholdAmplitude: number; toleranceSeconds: number };

const ffmpegPresent = await isFfmpegAvailable();

describe.skipIf(!ffmpegPresent)('MP3 decode-offset parity (ffmpeg path)', () => {
  it('decodes the marker fixture to the recorded anchor constant', async () => {
    const pcm = await decodePcmMono(join(fixtureDir, 'decode-parity-marker.mp3'));
    let anchorIndex = -1;
    for (let i = 0; i < pcm.length; i += 1) {
      if (Math.abs(pcm[i] ?? 0) >= expected.thresholdAmplitude) {
        anchorIndex = i;
        break;
      }
    }
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    const anchorSeconds = anchorIndex / ESTIMATOR_SAMPLE_RATE;
    expect(Math.abs(anchorSeconds - expected.anchorSeconds)).toBeLessThanOrEqual(
      expected.toleranceSeconds,
    );
    // Gapless handling: the decoded length must be the true 3 s, not 3 s plus
    // LAME encoder padding (which would betray ignored Xing metadata).
    expect(pcm.length / ESTIMATOR_SAMPLE_RATE).toBeGreaterThan(2.99);
    expect(pcm.length / ESTIMATOR_SAMPLE_RATE).toBeLessThan(3.06);
  });
});
