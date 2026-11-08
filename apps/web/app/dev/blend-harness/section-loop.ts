// The Section loop's render for the DSP harness: the REAL `BufferDecks` over a
// real source node in an OfflineAudioContext. The fixture is a ramp, so every
// rendered sample reads back as the exact position it came from, which makes a
// gap, a misplaced wrap or a lying clock visible sample by sample.

import type { BufferLoopRegion } from '@liedmotif/shared';
import type { PlayerEngine } from '@/components/player/audio-engine';
import { BufferDecks } from '@/components/player/buffer-decks';

const SAMPLE_RATE = 48000;
const TRACK_SECONDS = 8;

export interface SectionLoopRenderOptions {
  region: BufferLoopRegion;
  fromSeconds: number;
  renderSeconds: number;
  /** Render time at which the loop is cleared on the live source. */
  clearAtSeconds?: number;
  /** Render time at which position is read from both the audio and the clock. */
  probeAtSeconds: number;
}

export interface SectionLoopMetrics {
  /** Backward jumps in the rendered position. */
  wraps: number;
  /** Forward steps other than exactly one sample. */
  unexpectedJumps: number;
  silentSamples: number;
  renderedAtProbeSeconds: number;
  clockAtProbeSeconds: number | null;
}

/** A 32-bit float WAV of a ramp: value = position / duration, never zero. */
function rampWav(): Blob {
  const frames = SAMPLE_RATE * TRACK_SECONDS;
  const view = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  text(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i += 1) view.setFloat32(44 + i * 4, (i + 1) / frames, true);
  return new Blob([view.buffer], { type: 'audio/wav' });
}

export async function renderSectionLoop(
  options: SectionLoopRenderOptions,
): Promise<SectionLoopMetrics> {
  const ctx = new OfflineAudioContext(1, options.renderSeconds * SAMPLE_RATE, SAMPLE_RATE);
  const engine = {
    context: () => ctx,
    deckInput: () => ctx.destination,
  } as unknown as PlayerEngine;
  const wav = rampWav();
  const decks = new BufferDecks(
    () => engine,
    () => undefined,
    () => wav,
  );
  const track = { trackId: 'ramp', assets: { final: null, stream: null } };
  if (!(await decks.ensureDecoded(track))) throw new Error('the ramp fixture did not decode');
  if (!decks.parkAt('a', track.trackId, options.fromSeconds)) throw new Error('park refused');
  if (!decks.setLoop('a', options.region, options.fromSeconds)) throw new Error('loop refused');
  if (!decks.resume('a')) throw new Error('resume refused');

  // `suspend` lands on a render quantum, so these run with the clock at exactly
  // that point of the render.
  let clockAtProbeSeconds: number | null = null;
  const events = new Map<number, Array<() => void>>();
  const at = (seconds: number, run: () => void) => {
    events.set(seconds, [...(events.get(seconds) ?? []), run]);
  };
  if (options.clearAtSeconds != null) at(options.clearAtSeconds, () => decks.clearLoop('a'));
  at(options.probeAtSeconds, () => {
    clockAtProbeSeconds = decks.positionSeconds('a');
  });
  for (const [seconds, runs] of events) {
    void ctx.suspend(seconds).then(() => {
      for (const run of runs) run();
      void ctx.resume();
    });
  }

  const rendered = (await ctx.startRendering()).getChannelData(0);
  const positionOf = (index: number) => (rendered[index] ?? 0) * TRACK_SECONDS;
  const sample = 1 / SAMPLE_RATE;
  let wraps = 0;
  let unexpectedJumps = 0;
  let silentSamples = 0;
  for (let i = 0; i < rendered.length; i += 1) {
    if (rendered[i] === 0) silentSamples += 1;
    if (i === 0) continue;
    const step = positionOf(i) - positionOf(i - 1);
    if (step < 0) wraps += 1;
    else if (Math.abs(step - sample) > sample / 4) unexpectedJumps += 1;
  }
  return {
    wraps,
    unexpectedJumps,
    silentSamples,
    renderedAtProbeSeconds: positionOf(Math.round(options.probeAtSeconds * SAMPLE_RATE)),
    clockAtProbeSeconds,
  };
}
