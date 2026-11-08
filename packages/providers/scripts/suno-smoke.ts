// Opt-in Suno smoke test — the ONE place that makes real, paid network calls to
// Suno. It is intentionally NOT a `*.test.ts` and lives outside `src/`, so it is
// excluded from `npm test` / CI and never runs by accident.
//
// It is double-gated: it does nothing unless BOTH `SUNO_SMOKE=1` and a
// `SUNO_API_KEY` are set. Run it manually (and sparingly — it spends credits):
//
//   SUNO_SMOKE=1 SUNO_API_KEY=... npm run smoke:suno -w @liedmotif/providers
//
// It performs one real generate -> poll-to-SUCCESS -> credit check and prints a
// SANITIZED summary: counts, booleans, durations and the credit balance only —
// never a signed audio/stream URL or the API key.

import { sunoMusicProvider, type MusicGenerationInput } from '../src/index';

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 60; // ~5 minutes ceiling

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (process.env.SUNO_SMOKE !== '1') {
    console.log('Suno smoke test is gated. Set SUNO_SMOKE=1 and SUNO_API_KEY to run it.');
    return;
  }
  const apiKey = process.env.SUNO_API_KEY?.trim();
  if (!apiKey) {
    console.error('SUNO_API_KEY is required to run the smoke test.');
    process.exitCode = 1;
    return;
  }

  const provider = sunoMusicProvider({
    apiKey,
    ...(process.env.SUNO_BASE_URL?.trim() ? { baseUrl: process.env.SUNO_BASE_URL.trim() } : {}),
    ...(process.env.SUNO_MODEL?.trim() ? { defaultModel: process.env.SUNO_MODEL.trim() } : {}),
    ...(process.env.SUNO_CALLBACK_URL?.trim()
      ? { callbackUrl: process.env.SUNO_CALLBACK_URL.trim() }
      : {}),
  });

  console.log('1/3 validating credentials...');
  const validation = await provider.validateCredentials();
  console.log(`    ok=${validation.ok} message=${validation.message ?? ''}`);
  if (!validation.ok) {
    process.exitCode = 1;
    return;
  }

  const input: MusicGenerationInput = {
    mode: 'non_custom',
    prompt: 'A calm lo-fi instrumental study beat, mellow keys, soft vinyl crackle',
    instrumental: true,
  };

  console.log('2/3 submitting one generation...');
  const task = await provider.createGenerationTask(input);
  console.log(
    `    taskId=${task.providerTaskId} status=${task.status} model=${task.provider.model ?? ''}`,
  );

  console.log('3/3 polling record-info to completion...');
  for (let attempt = 1; attempt <= MAX_POLLS; attempt += 1) {
    const status = await provider.getGenerationStatus(task.providerTaskId);
    const tracks = status.tracks.map((track) => ({
      hasStream: Boolean(track.streamAudioUrl),
      hasFinal: Boolean(track.audioUrl),
      durationSeconds: track.durationSeconds ?? null,
    }));
    console.log(
      `    [${attempt}] status=${status.status}` +
        (status.failureReason ? ` failureReason=${status.failureReason}` : '') +
        ` tracks=${JSON.stringify(tracks)}`,
    );
    if (status.status === 'complete') {
      console.log('SUCCESS — generation reached SUCCESS.');
      break;
    }
    if (status.status === 'failed') {
      console.error(`FAILED — provider job failed (${status.failureReason}).`);
      process.exitCode = 1;
      return;
    }
    if (attempt === MAX_POLLS) {
      console.error('TIMEOUT — generation did not complete within the poll ceiling.');
      process.exitCode = 1;
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const credit = await provider.validateCredentials();
  console.log(`credit check: ${credit.message ?? ''}`);
}

main().catch((error: unknown) => {
  // Sanitized adapter errors only; never dump a raw provider body here.
  console.error('Smoke test errored:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
