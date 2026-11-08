import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// The offline-render DSP harness: transitions
// rendered through the REAL blend graph in an OfflineAudioContext at 192 kHz
// (≥4× oversampled vs 48 kHz playback) must meet these thresholds:
//
//   summed render true peak ≤ −1.0 dBTP
//   output gap across the transition ≤ 10 ms
//   short-term loudness delta across overlap ≤ ±1.5 LU at the mutual target
//   click detector: no sample step > 0.02 FS inside automation windows
//
// Plus the MP3 decode-offset parity gate: `decodeAudioData` must land the marker
// fixture's anchor on the same constant the worker's ffmpeg path recorded
// (equal LAME/Xing encoder-delay handling — a per-decoder constant offset would
// NOT cancel across a mixed media↔buffer edge).
//
// This verifies DSP correctness, not live media-element timing.

const FIXTURE_DIR = fileURLToPath(new URL('../../../worker/src/audio/fixtures', import.meta.url));

import type { BufferEdgeMetrics } from '../../app/dev/blend-harness/buffer-edge';
import type { EdgeMetrics, LoopSeamMetrics } from '../../app/dev/blend-harness/harness';
import type { ListeningScenarioResult } from '../../app/dev/blend-harness/listening-scenario';

// Rendering ~23 s of 192 kHz audio + JS loudness filtering takes a while.
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

async function harnessReady(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/dev/blend-harness');
  await expect(page.getByTestId('harness-ready')).toHaveText('ready');
}

test('a beat-quantized edge between unequal-loudness tracks meets every DSP gate', async ({
  page,
}) => {
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    // 120 BPM grids (0.5 s beats, anchor 0.25). Crossfade 4 s = 8 whole beats;
    // fade starts on the tail-grid beat at/before the 16 s deadline → 15.75 s;
    // the incoming head anchor (0.25 s) leads the fade start.
    return window.__liedmotifBlendHarness!.renderEdge({
      out: {
        durationSeconds: 20,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 220,
        toneAmplitude: 0.25,
        clickAmplitude: 0.25,
      },
      in: {
        durationSeconds: 20,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 277,
        toneAmplitude: 0.16,
        clickAmplitude: 0.15,
      },
      fadeStartSeconds: 15.75,
      fadeSeconds: 4,
      incomingStartSeconds: 15.5,
      gains: 'mutual',
    });
  })) as EdgeMetrics;

  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
  expect(metrics.clickMaxStep).toBeLessThanOrEqual(0.02);
  expect(metrics.loudnessDeltaLu).not.toBeNull();
  expect(metrics.loudnessDeltaLu!).toBeLessThanOrEqual(1.5);
  // The normalization really ran: the quieter track was brought TOWARD the
  // louder one's level within its headroom, and a mutual target exists.
  expect(metrics.mutualTargetLufs).not.toBeNull();
  expect(metrics.appliedGains.toDb).toBeGreaterThan(0);
});

test('the MINIMUM two-second fade meets the loudness gate (measured, never skipped)', async ({
  page,
}) => {
  // 2 s is the settings floor — the loudness window shrinks to the fade so the
  // gate MEASURES it (a null would mean "not measured" and must fail).
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    return window.__liedmotifBlendHarness!.renderEdge({
      out: {
        durationSeconds: 20,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 220,
        toneAmplitude: 0.25,
        clickAmplitude: 0.25,
      },
      in: {
        durationSeconds: 20,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 277,
        toneAmplitude: 0.16,
        clickAmplitude: 0.15,
      },
      fadeStartSeconds: 15.75,
      fadeSeconds: 2,
      incomingStartSeconds: 15.5,
      gains: 'mutual',
    });
  })) as EdgeMetrics;

  expect(metrics.loudnessDeltaLu).not.toBeNull();
  expect(metrics.loudnessDeltaLu!).toBeLessThanOrEqual(1.5);
  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
  expect(metrics.clickMaxStep).toBeLessThanOrEqual(0.02);
});

test('the single-track LOOP SEAM (production schedule, tail into its own head) meets every DSP gate', async ({
  page,
}) => {
  // Repeat-one loops the SAME track through a tail→head crossfade.
  // The render is scheduled by the PRODUCTION planner (`loopSeam` overlap +
  // `planAlignedEdge` on the tail/head grids), so a regression in the seam
  // schedule — fade off the tail beat, a lost head-anchor lead — shifts this
  // render and fails the gates, not just a hand-picked timeline.
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    return window.__liedmotifBlendHarness!.renderLoopSeam();
  })) as LoopSeamMetrics;

  // The production plan: whole-beat fade honoring the overlap, fade start ON
  // a tail-grid beat (120 BPM grid anchored 0.25 s → 15.75 s for a 20 s
  // track with a 4 s fade), incoming head anchor leading the fade start.
  expect(metrics.overlapSeconds).toBe(4);
  expect(metrics.plan.fadeBeats).toBe(8);
  expect(metrics.plan.fadeStartSeconds).toBeCloseTo(15.75, 6);
  expect(metrics.plan.incomingLeadSeconds).toBeCloseTo(0.25, 6);

  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
  expect(metrics.clickMaxStep).toBeLessThanOrEqual(0.02);
  expect(metrics.loudnessDeltaLu).not.toBeNull();
  expect(metrics.loudnessDeltaLu!).toBeLessThanOrEqual(1.5);
  // Same track on both decks: the mutual target exists and both sides get the
  // IDENTICAL gain (there is no louder/quieter side to reconcile).
  expect(metrics.mutualTargetLufs).not.toBeNull();
  expect(metrics.appliedGains.toDb).toBeCloseTo(metrics.appliedGains.fromDb, 6);
});

test('a hot (near-ceiling) outgoing track is attenuated and the summed render keeps headroom', async ({
  page,
}) => {
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    return window.__liedmotifBlendHarness!.renderEdge({
      out: {
        durationSeconds: 16,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 220,
        toneAmplitude: 0.7, // hot: ~-3 dBTP fixture peak
        clickAmplitude: 0.2,
      },
      in: {
        durationSeconds: 16,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 277,
        toneAmplitude: 0.18,
        clickAmplitude: 0.2,
      },
      fadeStartSeconds: 11.75,
      fadeSeconds: 4,
      incomingStartSeconds: 11.5,
      gains: 'mutual',
    });
  })) as EdgeMetrics;

  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
  expect(metrics.clickMaxStep).toBeLessThanOrEqual(0.02);
  // The louder track came DOWN toward the quieter one's achievable level.
  expect(metrics.appliedGains.fromDb).toBeLessThan(0);
});

test('CORRELATED near-ceiling transients keep the summed true peak under the ceiling', async ({
  page,
}) => {
  // Equal-power holds POWER constant
  // for uncorrelated signals, but identical phase-aligned content sums toward
  // +6 dB amplitude — headroom must be VERIFIED, not assumed. The DANGEROUS
  // shape is material already near the loudness target (mutual gains ≈ 0 —
  // forced here with explicit 0 dB gains) carrying sample-coincident
  // near-−1 dBTP FAST transients: 1 ms kick-like bursts, shorter than the
  // master compressor's 3 ms attack, landing sample-aligned throughout the
  // overlap (the tone phase also aligns exactly: 220 Hz × 11.5 s is a whole
  // number of cycles). No click assertion here — a near-full-scale 1 ms burst
  // legitimately exceeds the per-sample step gate, which targets automation
  // artifacts and is enforced by the other renders.
  await harnessReady(page);
  const hot = {
    durationSeconds: 16,
    bpm: 120,
    anchorSeconds: 0.25,
    toneHz: 220,
    toneAmplitude: 0.1, // quiet bed: the transients dominate the peak
    clickAmplitude: 0.78, // fixture true peak ≈ −1.2 dBTP
    burstSeconds: 0.001, // FASTER than the compressor attack
    burstHz: 1000,
  };
  const metrics = (await page.evaluate(async (spec) => {
    return window.__liedmotifBlendHarness!.renderEdge({
      out: spec,
      in: spec,
      fadeStartSeconds: 11.75,
      fadeSeconds: 4,
      incomingStartSeconds: 11.5,
      gains: { fromDb: 0, toDb: 0 },
    });
  }, hot)) as EdgeMetrics;

  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
});

test('the automation-failure hard-cut fallback stays gapless and click-safe', async ({ page }) => {
  // When the fade automation cannot be armed, the production degrade is a
  // click-safe hard cut into the incoming deck. Render exactly that fallback
  // through the real graph: no output gap beyond the threshold, no automation
  // click — an audible cut, never silence.
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    return window.__liedmotifBlendHarness!.renderEdge({
      out: {
        durationSeconds: 16,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 220,
        toneAmplitude: 0.25,
        clickAmplitude: 0.25,
      },
      in: {
        durationSeconds: 16,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 277,
        toneAmplitude: 0.22,
        clickAmplitude: 0.2,
      },
      fadeStartSeconds: 11.75,
      fadeSeconds: 4,
      incomingStartSeconds: 11.5,
      gains: 'mutual',
      simulateAutomationFailure: 'clicksafe',
    });
  })) as EdgeMetrics;

  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
  expect(metrics.clickMaxStep).toBeLessThanOrEqual(0.02);
  // The INCOMING deck won: its tone dominates and the outgoing is suppressed.
  expect(metrics.postTransition.incomingToneDb).toBeGreaterThan(
    metrics.postTransition.outgoingToneDb + 20,
  );
});

test('the EMERGENCY direct-value cut keeps audio present (deliberately outside the click gate)', async ({
  page,
}) => {
  // The deepest fallback — direct `AudioParam.value` assignment when even the
  // click-safe primitives throw — is by design an instantaneous step: audible
  // over elegant. The click gate does not apply (the discontinuity IS the
  // accepted cost); what MUST hold is presence of audio (no gap), headroom,
  // and that the incoming deck is really audible after the cut.
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    return window.__liedmotifBlendHarness!.renderEdge({
      out: {
        durationSeconds: 16,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 220,
        toneAmplitude: 0.25,
        clickAmplitude: 0.25,
      },
      in: {
        durationSeconds: 16,
        bpm: 120,
        anchorSeconds: 0.25,
        toneHz: 277,
        toneAmplitude: 0.22,
        clickAmplitude: 0.2,
      },
      fadeStartSeconds: 11.75,
      fadeSeconds: 4,
      incomingStartSeconds: 11.5,
      gains: 'mutual',
      simulateAutomationFailure: 'emergency',
    });
  })) as EdgeMetrics;

  expect(metrics.truePeakDb).toBeLessThanOrEqual(-1.0);
  expect(metrics.outputGapMs).toBeLessThanOrEqual(10);
  // The INCOMING deck won even on the deepest fallback — non-silence alone
  // would not prove the cut landed on the right deck.
  expect(metrics.postTransition.incomingToneDb).toBeGreaterThan(
    metrics.postTransition.outgoingToneDb + 20,
  );
});

test('MP3 decode-offset parity: decodeAudioData vs ffmpeg, compared DIRECTLY', async ({ page }) => {
  const expected = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'decode-parity-expected.json'), 'utf8'),
  ) as { anchorSeconds: number; thresholdAmplitude: number; toleranceSeconds: number };
  const mp3 = readFileSync(join(FIXTURE_DIR, 'decode-parity-marker.mp3'));

  await page.route('**/harness-fixtures/decode-parity-marker.mp3', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: mp3 }),
  );
  await harnessReady(page);

  const anchor = await page.evaluate(
    async (threshold) =>
      window.__liedmotifBlendHarness!.decodeAnchorSeconds(
        '/harness-fixtures/decode-parity-marker.mp3',
        threshold,
      ),
    expected.thresholdAmplitude,
  );
  expect(anchor).not.toBeNull();
  // Pin against the recorded constant (drift guard for BOTH decoders)…
  expect(Math.abs((anchor as number) - expected.anchorSeconds)).toBeLessThanOrEqual(
    expected.toleranceSeconds,
  );

  // …and, where the host has ffmpeg (the playback-harness CI job installs it),
  // compare the two decoders DIRECTLY in one result: independent ±tolerances
  // around a constant would allow their combined separation to double, but the
  // parity requirement is that the DECODERS agree with each other.
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const decode = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-i',
        join(FIXTURE_DIR, 'decode-parity-marker.mp3'),
        '-ac',
        '1',
        '-ar',
        '22050',
        '-f',
        'f32le',
        '-',
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    expect(decode.status).toBe(0);
    const bytes: Buffer = decode.stdout;
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
    let ffmpegAnchor = -1;
    for (let i = 0; i < pcm.length; i += 1) {
      if (Math.abs(pcm[i] ?? 0) >= expected.thresholdAmplitude) {
        ffmpegAnchor = i / 22_050;
        break;
      }
    }
    expect(ffmpegAnchor).toBeGreaterThan(0);
    // Direct decoder-to-decoder parity: within 1 ms of each other.
    expect(Math.abs((anchor as number) - ffmpegAnchor)).toBeLessThanOrEqual(0.001);
  }

  // The SHIPPED worker decoder: in CI the worker-image job exports its
  // measured anchor as an artifact and this job compares Chrome against it
  // DIRECTLY — the production decoder pair, not a proxy. (Locally the file is
  // absent and the host-ffmpeg comparison above stands in.)
  const imageParityFile = process.env.WORKER_IMAGE_PARITY_FILE;
  if (imageParityFile) {
    // When the env var is CONFIGURED (the CI job always sets it), a missing or
    // malformed file is a FAILURE, never a silent skip.
    expect(
      existsSync(imageParityFile),
      `missing shipped-decoder anchor at ${imageParityFile}`,
    ).toBe(true);
    const imageMeasured = JSON.parse(readFileSync(imageParityFile, 'utf8')) as {
      anchorSeconds: number;
    };
    expect(typeof imageMeasured.anchorSeconds).toBe('number');
    expect(Math.abs((anchor as number) - imageMeasured.anchorSeconds)).toBeLessThanOrEqual(0.0015);
  }
});

test('a BUFFER↔BUFFER beat-locked edge meets the buffer budgets', async ({ page }) => {
  // The buffer↔buffer beat-locked tier: the REAL planner schedules
  // two AudioBufferSourceNodes on the render clock (an off-target incoming
  // tempo forces a genuine rate lock), and the rendered output is measured —
  // scheduler error ≤ 1 ms, end-to-end audible beat phase error ≤ 5 ms.
  // Onset counts guard against a vacuously passing
  // measurement: a silent deck must FAIL here.
  await harnessReady(page);
  const metrics = (await page.evaluate(async () => {
    return window.__liedmotifBlendHarness!.renderBufferEdge();
  })) as BufferEdgeMetrics;

  expect(metrics.tier).toBe('beat-locked');
  // A real lock: 121.5 → 120 BPM is a ~1.2% rate, inside the ±1.5% buffer cap.
  expect(Math.abs(metrics.incomingRate - 1)).toBeGreaterThan(0.005);
  expect(Math.abs(metrics.incomingRate - 1)).toBeLessThanOrEqual(0.015);

  expect(metrics.outgoingOnsets).toBeGreaterThanOrEqual(3);
  expect(metrics.incomingOnsets).toBeGreaterThanOrEqual(3);
  expect(metrics.settledOnsets).toBeGreaterThanOrEqual(3);

  const detail = `scheduler ${metrics.schedulerErrorMs.toFixed(3)} ms, phase ${metrics.beatPhaseErrorMs.toFixed(3)} ms`;
  expect(metrics.schedulerErrorMs, detail).toBeLessThanOrEqual(1);
  expect(metrics.beatPhaseErrorMs, detail).toBeLessThanOrEqual(5);
});

test('listening accounting on real media elements survives seek, mute, handoff, crossfade and loop', async ({
  page,
}) => {
  await harnessReady(page);
  // Unmuted media playback needs a user activation.
  await page.getByTestId('harness-ready').click();
  const result = (await page.evaluate(() =>
    window.__liedmotifBlendHarness!.runListeningScenario(),
  )) as ListeningScenarioResult;

  // Pause/seek/resume and the source handoff stayed inside one occurrence; the
  // duplicated `ended` callback ended it once; the loop opened its own.
  expect(result.occurrences.map((o) => [o.trackId, o.origin, o.endReason])).toEqual([
    ['t1', 'user', 'ended'],
    ['t2', 'auto', 'ended'],
    ['t2', 'loop', 'stopped'],
  ]);

  const [first, second, loop] = result.occurrences as [
    ListeningScenarioResult['occurrences'][number],
    ListeningScenarioResult['occurrences'][number],
    ListeningScenarioResult['occurrences'][number],
  ];
  // Observations are 200 ms apart and each state change can cost one.
  const TOLERANCE_MS = 1200;
  // Played time is the audible wall time: the seek's jump, the muted second and
  // the zero-volume stretch added nothing.
  expect(result.seekJumpSeconds).toBeGreaterThan(1.5);
  expect(Math.abs(first.playedMs - result.firstTrackAudibleMs)).toBeLessThan(TOLERANCE_MS);
  expect(first.playedMs).toBeLessThan(4500);

  // The crossfade was shared, not double-counted: credits sum to the player's
  // audible time, while what each Track played keeps the overlap whole.
  const credited = first.listenedMs + second.listenedMs + loop.listenedMs;
  expect(Math.abs(credited - result.totalAudibleMs)).toBeLessThan(TOLERANCE_MS);
  expect(first.listenedMs).toBeLessThan(first.playedMs);
  expect(second.listenedMs).toBeLessThan(second.playedMs);
});

test('a Section loop repeats on the real audio thread: no gap, exact wraps, truthful clock', async ({
  page,
}) => {
  await harnessReady(page);
  const metrics = await page.evaluate(() =>
    window.__liedmotifBlendHarness!.renderSectionLoop({
      region: { startSeconds: 2, endSeconds: 4 },
      fromSeconds: 2,
      renderSeconds: 11,
      probeAtSeconds: 5,
    }),
  );
  // 11 s at a 2 s region starting on it: wraps at 2, 4, 6, 8 and 10 s.
  expect(metrics.wraps).toBe(5);
  expect(metrics.unexpectedJumps).toBe(0);
  expect(metrics.silentSamples).toBe(0);
  // 5 s into a 2 s region starting at 2 s: 1 s into its third pass.
  expect(metrics.renderedAtProbeSeconds).toBeCloseTo(3, 3);
  expect(metrics.clockAtProbeSeconds).toBeCloseTo(3, 2);
});

test('a Section loop started before its region plays into it, then repeats', async ({ page }) => {
  await harnessReady(page);
  const metrics = await page.evaluate(() =>
    window.__liedmotifBlendHarness!.renderSectionLoop({
      region: { startSeconds: 3, endSeconds: 4 },
      fromSeconds: 1,
      renderSeconds: 6,
      probeAtSeconds: 3.5,
    }),
  );
  // Reaches the end at 3 s of render, then wraps every 1 s.
  expect(metrics.wraps).toBe(3);
  expect(metrics.unexpectedJumps).toBe(0);
  expect(metrics.renderedAtProbeSeconds).toBeCloseTo(3.5, 3);
  expect(metrics.clockAtProbeSeconds).toBeCloseTo(3.5, 2);
});

test('clearing a Section loop lets the same source play on past the region, unbroken', async ({
  page,
}) => {
  await harnessReady(page);
  const metrics = await page.evaluate(() =>
    window.__liedmotifBlendHarness!.renderSectionLoop({
      region: { startSeconds: 2, endSeconds: 4 },
      fromSeconds: 2,
      renderSeconds: 5,
      clearAtSeconds: 3,
      probeAtSeconds: 4.5,
    }),
  );
  // One wrap at 2 s of render; cleared at 3 s (position 3); then straight on.
  expect(metrics.wraps).toBe(1);
  expect(metrics.unexpectedJumps).toBe(0);
  expect(metrics.silentSamples).toBe(0);
  expect(metrics.renderedAtProbeSeconds).toBeCloseTo(4.5, 3);
  expect(metrics.clockAtProbeSeconds).toBeCloseTo(4.5, 2);
});
