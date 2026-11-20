import { describe, expect, it } from 'vitest';
import type { LyricLine } from '@liedmotif/shared';
import {
  activeLyricLineIndex,
  lyricLineInteraction,
  lyricLineStates,
  lyricsTimingStatus,
  showLyricsAffordance,
} from './lyrics-view';

const LINES: LyricLine[] = [
  { kind: 'section', label: 'Verse' },
  { kind: 'line', text: 'First line', timeSeconds: 6 },
  { kind: 'line', text: 'Unmatched line', timeSeconds: null },
  { kind: 'line', text: 'Second line', timeSeconds: 13 },
  { kind: 'section', label: 'Chorus' },
  { kind: 'line', text: 'Third line', timeSeconds: 22 },
];

describe('activeLyricLineIndex', () => {
  it('lights the greatest timed line at or before the position', () => {
    expect(activeLyricLineIndex(LINES, 0)).toBe(-1); // before the first word
    expect(activeLyricLineIndex(LINES, 6)).toBe(1);
    expect(activeLyricLineIndex(LINES, 12.9)).toBe(1);
    expect(activeLyricLineIndex(LINES, 13)).toBe(3);
    expect(activeLyricLineIndex(LINES, 60)).toBe(5);
    expect(activeLyricLineIndex(LINES, null)).toBe(-1);
  });
});

describe('lyricLineStates', () => {
  it('marks past/active/next around the active index; sections and untimed lines stay next', () => {
    expect(lyricLineStates(LINES, activeLyricLineIndex(LINES, 13), true)).toEqual([
      'next', // section
      'past',
      'next', // untimed
      'active',
      'next', // section
      'next',
    ]);
  });

  it('marks nothing past while no line is active yet', () => {
    expect(lyricLineStates(LINES, -1, true)).toEqual(Array(LINES.length).fill('next'));
  });

  it('renders every row as next on an unsynced view', () => {
    expect(lyricLineStates(LINES, 3, false)).toEqual(Array(LINES.length).fill('next'));
  });
});

describe('showLyricsAffordance', () => {
  it('offers the surfaces only for a vocal track whose words are captured', () => {
    expect(showLyricsAffordance({ vocalMode: 'vocal', hasLyrics: true })).toBe(true);
    expect(showLyricsAffordance({ vocalMode: 'vocal', hasLyrics: false })).toBe(false);
    expect(showLyricsAffordance({ vocalMode: 'instrumental', hasLyrics: true })).toBe(false);
    expect(showLyricsAffordance(null)).toBe(false);
  });
});

describe('lyricsTimingStatus', () => {
  it('promises timing that is still on the way instead of denying it', () => {
    expect(lyricsTimingStatus({ synced: true, settled: true })).toEqual({
      label: 'Tap a line to jump',
      tone: 'neutral',
      detail: null,
    });
    expect(lyricsTimingStatus({ synced: false, settled: false })).toMatchObject({
      label: expect.stringMatching(/on its way/i),
      tone: 'lamp',
    });
    expect(lyricsTimingStatus({ synced: false, settled: true })).toMatchObject({
      label: 'No line timing for this track',
      tone: 'neutral',
    });
  });

  it('carries a card body only when there is something to explain', () => {
    expect(lyricsTimingStatus({ synced: true, settled: false }).detail).toBeNull();
    expect(lyricsTimingStatus({ synced: false, settled: false }).detail).toBeTruthy();
    expect(lyricsTimingStatus({ synced: false, settled: true }).detail).toBeTruthy();
  });
});

describe('lyricLineInteraction', () => {
  const line = { kind: 'line', text: 'First line', timeSeconds: 6 } as const;

  it('seeks to the line time and is enabled only on a synced, timed line', () => {
    const seeks: number[] = [];
    const props = lyricLineInteraction(line, 'active', true, (s) => seeks.push(s));
    expect(props).toMatchObject({
      'data-state': 'active',
      'aria-current': 'true',
      disabled: false,
    });
    props.onClick();
    expect(seeks).toEqual([6]);
  });

  it('disables untimed lines and every line of an unsynced view', () => {
    const noop = () => {};
    expect(lyricLineInteraction({ ...line, timeSeconds: null }, 'next', true, noop).disabled).toBe(
      true,
    );
    const unsynced = lyricLineInteraction(line, 'next', false, noop);
    expect(unsynced.disabled).toBe(true);
    expect(unsynced['aria-current']).toBeUndefined();
  });
});
