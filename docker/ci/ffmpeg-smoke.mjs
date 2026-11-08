// In-container ffmpeg smoke for the CI `worker-image` job. Runs INSIDE the built
// worker image:
//
//   docker run --rm -v "$PWD/docker/ci:/ci:ro" --entrypoint node \
//     <worker-image> /ci/ffmpeg-smoke.mjs
//
// Asserts the licensing/compliance pins the NOTICE records and the analysis
// pipeline's runtime assumptions:
//   1. the installed ffmpeg package version matches `ffmpeg-pin.txt` (a bump
//      must update the pin AND the NOTICE's corresponding-source URLs). One
//      pin serves every arch: Debian builds each arch from the same source
//      version, and that source is what the NOTICE names,
//   2. `ffmpeg -buildconf` matches `ffmpeg-buildconf-expected-<arch>.txt` for
//      the image's Debian architecture (the exact configuration the licensing
//      review covered; Debian's flags differ per arch, see NOTICE.md),
//   3. the package's Debian `copyright` file is retained in-image,
//   4. one `loudnorm` measure pass over a synthesized sine fixture lands
//      within ±0.5 LU / ±0.5 dB of the checked-in expectation,
//   5. MP3 decode-offset parity: THIS image's ffmpeg decodes the
//      marker fixture to the recorded anchor constant — the same constant
//      `decodeAudioData` is pinned to in the browser harness. The fixtures
//      directory must be mounted at /fixtures (see the workflow); a missing
//      mount is FATAL, never a skip.
//
// Plain Node + the ffmpeg binary — no npm dependencies, so it runs in the
// stripped runtime image as-is.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ciDir = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};
const ok = (msg) => console.log(`ok: ${msg}`);

// 1. Exact package pin.
const expectedVersion = readFileSync(join(ciDir, 'ffmpeg-pin.txt'), 'utf8').trim();
const installedVersion = execFileSync('dpkg-query', ['-W', '-f', '${Version}', 'ffmpeg'], {
  encoding: 'utf8',
}).trim();
if (installedVersion === expectedVersion) {
  ok(`ffmpeg package version ${installedVersion} matches the pin`);
} else {
  fail(
    `ffmpeg package version drifted: installed ${installedVersion}, pinned ${expectedVersion}. ` +
      'Update docker/ci/ffmpeg-pin.txt AND the NOTICE corresponding-source URLs together.',
  );
}

// 2. Build configuration matches the reviewed pin for this arch.
const arch = execFileSync('dpkg', ['--print-architecture'], { encoding: 'utf8' }).trim();
const buildconfFile = `ffmpeg-buildconf-expected-${arch}.txt`;
if (!existsSync(join(ciDir, buildconfFile))) {
  fail(`no reviewed build configuration for arch ${arch}: docker/ci/${buildconfFile} is missing`);
} else {
  const expectedFlags = readFileSync(join(ciDir, buildconfFile), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const buildconf = execFileSync('ffmpeg', ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
  const actualFlags = buildconf
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('--'));
  const missing = expectedFlags.filter((flag) => !actualFlags.includes(flag));
  const extra = actualFlags.filter((flag) => !expectedFlags.includes(flag));
  if (missing.length === 0 && extra.length === 0) {
    ok(`${arch} buildconf matches the pinned configuration (${actualFlags.length} flags)`);
  } else {
    fail(
      `${arch} buildconf drifted from docker/ci/${buildconfFile}. missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
    );
  }
}

// 3. The GPL compliance artifact ships in-image.
const copyrightPath = '/usr/share/doc/ffmpeg/copyright';
if (existsSync(copyrightPath)) {
  ok(`Debian copyright file retained at ${copyrightPath}`);
} else {
  fail(`${copyrightPath} missing — the image must retain the package's copyright file`);
}

// 4. loudnorm fixture measure. The fixture is synthesized here (deterministic
// 997 Hz sine, amplitude 0.25, 5 s mono 44.1 kHz 16-bit WAV) so no binary
// lives in git; expectations are analytic (≈ −15.0 LUFS, ≈ −12.0 dBTP) and
// were verified against this exact ffmpeg build.
const expectedLoudness = JSON.parse(
  readFileSync(join(ciDir, 'loudness-fixture-expected.json'), 'utf8'),
);
const sampleRate = 44100;
const seconds = 5;
const amplitude = 0.25;
const samples = sampleRate * seconds;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0, 'ascii');
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write('WAVE', 8, 'ascii');
wav.write('fmt ', 12, 'ascii');
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36, 'ascii');
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const v = amplitude * Math.sin((2 * Math.PI * 997 * i) / sampleRate);
  wav.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}
const fixturePath = '/tmp/loudness-fixture.wav';
writeFileSync(fixturePath, wav);

const loudnorm = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-nostats',
    '-i',
    fixturePath,
    '-af',
    'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
    '-f',
    'null',
    '-',
  ],
  { encoding: 'utf8', timeout: 60_000 },
);
if (loudnorm.status !== 0) {
  fail(`loudnorm pass exited with ${loudnorm.status}`);
} else {
  // The JSON block sits at the tail of stderr.
  const stderr = loudnorm.stderr;
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  const measured = JSON.parse(stderr.slice(start, end + 1));
  const integrated = Number(measured.input_i);
  const truePeak = Number(measured.input_tp);
  const luDelta = Math.abs(integrated - expectedLoudness.input_i);
  const tpDelta = Math.abs(truePeak - expectedLoudness.input_tp);
  if (luDelta <= 0.5 && tpDelta <= 0.5) {
    ok(`loudnorm fixture measure within tolerance (I=${integrated} LUFS, TP=${truePeak} dBTP)`);
  } else {
    fail(
      `loudnorm fixture measure drifted: I=${integrated} (expected ${expectedLoudness.input_i} ±0.5), ` +
        `TP=${truePeak} (expected ${expectedLoudness.input_tp} ±0.5)`,
    );
  }
}

// 5. MP3 decode-offset parity against THIS image's decoder: decode the
// marker fixture the same way the worker's estimator input pass does (mono
// 22 050 Hz f32le) and assert the first sample at/above the threshold lands on the recorded anchor. A
// per-decoder constant offset would shift every anchor and does NOT cancel
// across a mixed media↔buffer edge. Fatal — this is the shipped decoder.
const fixturesDir = '/fixtures';
const markerPath = join(fixturesDir, 'decode-parity-marker.mp3');
const expectedParityPath = join(fixturesDir, 'decode-parity-expected.json');
if (!existsSync(markerPath) || !existsSync(expectedParityPath)) {
  fail(
    `decode-parity fixtures not mounted at ${fixturesDir} — run with ` +
      '-v "$PWD/apps/worker/src/audio/fixtures:/fixtures:ro"',
  );
} else {
  const expectedParity = JSON.parse(readFileSync(expectedParityPath, 'utf8'));
  const estimatorRate = 22_050;
  const decode = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      markerPath,
      '-ac',
      '1',
      '-ar',
      String(estimatorRate),
      '-f',
      'f32le',
      '-',
    ],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (decode.status !== 0) {
    fail(`parity fixture decode exited with ${decode.status}`);
  } else {
    const bytes = decode.stdout;
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
    let anchorIndex = -1;
    for (let i = 0; i < pcm.length; i++) {
      if (Math.abs(pcm[i]) >= expectedParity.thresholdAmplitude) {
        anchorIndex = i;
        break;
      }
    }
    const anchorSeconds = anchorIndex / estimatorRate;
    // Export the measured anchor for the DIRECT cross-job comparison: the
    // playback-harness job downloads it and compares Chrome's decodeAudioData
    // anchor against THIS image's decoder, decoder-to-decoder.
    if (existsSync('/out')) {
      writeFileSync(
        '/out/decode-parity-measured.json',
        JSON.stringify({ anchorSeconds, sampleRate: estimatorRate }),
      );
      ok(`measured anchor exported to /out/decode-parity-measured.json`);
    }
    if (
      anchorIndex >= 0 &&
      Math.abs(anchorSeconds - expectedParity.anchorSeconds) <= expectedParity.toleranceSeconds
    ) {
      ok(`MP3 decode-offset parity holds (anchor ${anchorSeconds.toFixed(5)} s)`);
    } else {
      fail(
        `MP3 decode-offset parity broken: anchor ${anchorSeconds.toFixed(5)} s, expected ` +
          `${expectedParity.anchorSeconds} ±${expectedParity.toleranceSeconds} — this image's ` +
          'ffmpeg handles MP3 encoder delay differently; measured MP3 anchors must not activate alignment.',
      );
    }
  }
}

if (failures > 0) {
  console.error(`${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('ffmpeg smoke: all checks passed');
