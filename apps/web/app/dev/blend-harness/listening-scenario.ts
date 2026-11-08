// Listening accounting against REAL media elements: the production
// meter and audible-advance probe driven by an actual <audio> clock through a
// seek, app mute, zero volume, pause, a source handoff, a crossfade and a loop.
// Only the sender is replaced — reports are collected instead of posted.

import {
  createAudibleAdvanceProbe,
  createListeningMeter,
  type ListeningReport,
} from '@/components/player/listening-meter';

export interface ListeningScenarioResult {
  /** The last report of each occurrence, in start order. */
  occurrences: ListeningReport[];
  /** Wall time the scenario kept Track 1 audibly playing, measured independently of the meter. */
  firstTrackAudibleMs: number;
  /** Wall time with any audio audibly playing. */
  totalAudibleMs: number;
  /** Media seconds the seek jumped over. */
  seekJumpSeconds: number;
}

function toneWavUrl(seconds: number, hz: number): string {
  const rate = 8000;
  const samples = Math.floor(seconds * rate);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * hz * i) / rate) * 3000, true);
  }
  return URL.createObjectURL(new Blob([view], { type: 'audio/wav' }));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = (event: string, el: HTMLAudioElement) =>
  new Promise<void>((resolve) => el.addEventListener(event, () => resolve(), { once: true }));

export async function runListeningScenario(): Promise<ListeningScenarioResult> {
  const FIRST_SECONDS = 6;
  const firstUrl = toneWavUrl(FIRST_SECONDS, 220);
  const finalUrl = toneWavUrl(FIRST_SECONDS, 220);
  const secondUrl = toneWavUrl(2, 330);
  const a = new Audio(firstUrl);
  const b = new Audio(secondUrl);

  const sent: ListeningReport[] = [];
  const meter = createListeningMeter({
    send: (report) => sent.push(report),
    now: Date.now,
    newOccurrenceId: () => crypto.randomUUID(),
  });
  const audible = (el: HTMLAudioElement) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  // One player, two decks: the newest deck is the one the clock is read from.
  let active = a;
  const advancing = createAudibleAdvanceProbe(() => ({
    position: active.currentTime,
    audible: audible(active),
  }));
  const ticker = setInterval(() => meter.observe(advancing()), 200);

  let firstTrackAudibleMs = 0;
  let totalAudibleMs = 0;
  let last = performance.now();
  const stopwatch = setInterval(() => {
    const now = performance.now();
    if (audible(a)) firstTrackAudibleMs += now - last;
    if (audible(a) || audible(b)) totalAudibleMs += now - last;
    last = now;
  }, 20);

  // A wrapper-duplicated `ended` callback must end the occurrence once.
  for (let i = 0; i < 2; i++) a.addEventListener('ended', () => meter.close('t1', 'ended'));

  await a.play();
  meter.begin({ trackId: 't1', sessionId: null, surface: 'playlist' }, { origin: 'user' });
  await wait(1500);

  const seekFrom = a.currentTime;
  a.currentTime = 3.5;
  await until('seeked', a);
  const seekJumpSeconds = 3.5 - seekFrom;
  await wait(500);

  a.muted = true;
  await wait(1000);
  a.muted = false;
  a.volume = 0;
  await wait(800);
  a.volume = 1;

  a.pause();
  meter.observe(false);
  await wait(600);

  // Stream-to-final handoff: another source for the same Track, same position.
  const position = a.currentTime;
  a.src = finalUrl;
  a.currentTime = position;
  await a.play();
  meter.resume({ trackId: 't1', sessionId: null, surface: 'playlist' });

  // Crossfade: the second Track starts under the first one's last 600 ms.
  while (a.currentTime < FIRST_SECONDS - 0.6) await wait(20);
  const overlapMs = (FIRST_SECONDS - a.currentTime) * 1000;
  await b.play();
  active = b;
  meter.begin({ trackId: 't2', sessionId: null, surface: 'playlist' }, { overlapMs });

  // Passive loop: the same Track comes round with nobody asking.
  await until('ended', b);
  meter.close('t2', 'ended');
  b.currentTime = 0;
  await b.play();
  meter.begin({ trackId: 't2', sessionId: null, surface: 'playlist' });
  await wait(1000);
  b.pause();
  meter.end('stopped');

  clearInterval(ticker);
  clearInterval(stopwatch);
  for (const url of [firstUrl, finalUrl, secondUrl]) URL.revokeObjectURL(url);

  const byOccurrence = new Map<string, ListeningReport>();
  for (const report of sent) byOccurrence.set(report.occurrenceId, report);
  return {
    occurrences: [...byOccurrence.values()],
    firstTrackAudibleMs,
    totalAudibleMs,
    seekJumpSeconds,
  };
}
