// The Section loop's pure rules: a listener-marked stretch of one Track that
// repeats until they stop it.

import { BPM_CONFIDENCE_FLOOR, type BlendAnalysis } from '../contracts/blend';
import type { BufferLoopRegion } from './buffer-transport';

export const SECTION_LOOP_MIN_SECONDS = 1;
/** A loop ends this far short of the Track's end: the seek funnel will not land
 *  within 0.3 s of it, so a loop end must sit clear of that. */
export const SECTION_LOOP_END_MARGIN_SECONDS = 0.5;
/** Summed beats land a float's width off a bound they exactly reach. */
const BEAT_SUM_SLACK = 1e-9;

/** Samples read per bar: enough for a steady loudness, cheap on a long Track. */
const SAMPLES_PER_BAR = 2048;
/** How many bars the Loop a Part waveform draws. */
export const WAVEFORM_BAR_COUNT = 96;

/**
 * Bar heights (0..1) for a waveform, from one channel of a decoded Track. Each
 * bar is its stretch's RMS loudness, squared against the loudest bar: raw peaks
 * of a mastered Track are a flat wall that hides where its sections change.
 */
export function waveformBars(samples: Float32Array, barCount: number): number[] {
  const loudness = Array.from({ length: barCount }, (_, bar) => {
    const start = Math.floor((bar * samples.length) / barCount);
    const end = Math.ceil(((bar + 1) * samples.length) / barCount);
    const step = Math.max(1, Math.floor((end - start) / SAMPLES_PER_BAR));
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i += step) {
      sum += (samples[i] ?? 0) ** 2;
      count += 1;
    }
    return count > 0 ? Math.sqrt(sum / count) : 0;
  });
  const loudest = Math.max(...loudness);
  return loudest > 0 ? loudness.map((value) => (value / loudest) ** 2) : loudness;
}

export interface SnapLoopContext {
  durationSeconds: number;
  analysis: Pick<
    BlendAnalysis,
    | 'bpmConfidence'
    | 'headBeatAnchorSeconds'
    | 'headBeatPeriodSeconds'
    | 'tailBeatAnchorSeconds'
    | 'tailBeatPeriodSeconds'
  > | null;
  targetBpm: number | null;
}

interface BeatGrid {
  anchorSeconds: number;
  periodSeconds: number;
}

function beatGrid(anchorSeconds: number | null, periodSeconds: number | null): BeatGrid | null {
  return anchorSeconds != null && periodSeconds != null ? { anchorSeconds, periodSeconds } : null;
}

/** The trustworthy measured grid nearer `seconds`: a single anchor and period
 *  cannot bound the phase error across a long Track that drifts. */
function nearestGrid(seconds: number, analysis: SnapLoopContext['analysis']): BeatGrid | null {
  if (!analysis || (analysis.bpmConfidence ?? 0) < BPM_CONFIDENCE_FLOOR) return null;
  const head = beatGrid(analysis.headBeatAnchorSeconds, analysis.headBeatPeriodSeconds);
  const tail = beatGrid(analysis.tailBeatAnchorSeconds, analysis.tailBeatPeriodSeconds);
  if (!head || !tail) return head ?? tail;
  const tailNearer =
    Math.abs(seconds - tail.anchorSeconds) < Math.abs(seconds - head.anchorSeconds);
  return tailNearer ? tail : head;
}

/**
 * Where a listener's marks land. A loop whose length is whole beats keeps time
 * across its seam wherever it starts, so that comes first: a measured grid places
 * the start on a beat too, a target tempo only times the length, and with neither
 * the marks stand. Always at least a second long and clear of the Track's end.
 */
export function snapLoopRegion(
  marked: BufferLoopRegion,
  { durationSeconds, analysis, targetBpm }: SnapLoopContext,
): BufferLoopRegion {
  const lastEnd = durationSeconds - SECTION_LOOP_END_MARGIN_SECONDS;
  const length = Math.max(marked.endSeconds - marked.startSeconds, SECTION_LOOP_MIN_SECONDS);
  const raw = (): BufferLoopRegion => {
    const endSeconds = Math.min(marked.startSeconds + length, lastEnd);
    return { startSeconds: Math.max(0, endSeconds - length), endSeconds };
  };

  const grid = nearestGrid(marked.startSeconds, analysis);
  const periodSeconds = grid?.periodSeconds ?? (targetBpm ? 60 / targetBpm : null);
  if (!periodSeconds) return raw();

  let startSeconds = marked.startSeconds;
  if (grid) {
    const beat = Math.round((marked.startSeconds - grid.anchorSeconds) / periodSeconds);
    startSeconds = grid.anchorSeconds + beat * periodSeconds;
    if (startSeconds < 0) startSeconds += periodSeconds;
  }
  const wanted = Math.max(
    Math.round((marked.endSeconds - marked.startSeconds) / periodSeconds),
    Math.ceil(SECTION_LOOP_MIN_SECONDS / periodSeconds),
  );
  const beats = Math.min(
    wanted,
    Math.floor((lastEnd - startSeconds) / periodSeconds + BEAT_SUM_SLACK),
  );
  const endSeconds = startSeconds + beats * periodSeconds;
  return endSeconds - startSeconds >= SECTION_LOOP_MIN_SECONDS - BEAT_SUM_SLACK
    ? { startSeconds, endSeconds }
    : raw();
}
