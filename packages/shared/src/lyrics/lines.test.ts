import { describe, expect, it } from 'vitest';
import { buildLyricLines, parseLyricsText } from './lines';
import type { TimedLyrics } from './timed';

const TEXT = [
  '[Verse 1]',
  'Halb zwei, der Kaffee ist kalt!',
  'Ein Cursor blinkt',
  '',
  '[Chorus]',
  'KI statt Gute Nacht',
  'KI statt Gute Nacht',
].join('\n');

function timed(
  words: Array<[string, number, number] | [string, number, number, boolean]>,
): TimedLyrics {
  return {
    words: words.map(([word, startSeconds, endSeconds, success]) => ({
      word,
      startSeconds,
      endSeconds,
      success: success ?? true,
    })),
    alignmentErrorScore: 0.05,
  };
}

describe('parseLyricsText', () => {
  it('splits into section labels and text lines, dropping blanks', () => {
    expect(parseLyricsText(TEXT)).toEqual([
      { kind: 'section', label: 'Verse 1' },
      { kind: 'line', text: 'Halb zwei, der Kaffee ist kalt!', timeSeconds: null },
      { kind: 'line', text: 'Ein Cursor blinkt', timeSeconds: null },
      { kind: 'section', label: 'Chorus' },
      { kind: 'line', text: 'KI statt Gute Nacht', timeSeconds: null },
      { kind: 'line', text: 'KI statt Gute Nacht', timeSeconds: null },
    ]);
  });

  it('treats an empty tag as a plain line', () => {
    expect(parseLyricsText('[]')).toEqual([{ kind: 'line', text: '[]', timeSeconds: null }]);
  });
});

describe('buildLyricLines', () => {
  it('is the unsynced parse when no timing exists', () => {
    const result = buildLyricLines(TEXT, null);
    expect(result.synced).toBe(false);
    expect(result.lines).toEqual(parseLyricsText(TEXT));
  });

  it('times each line from its first aligned word, across word-boundary and punctuation differences', () => {
    const result = buildLyricLines(
      TEXT,
      timed([
        ['[Verse 1]\n', 0, 0.2, false],
        ['Halb ', 6.0, 6.2],
        ['zwei, der Kaffee ', 6.2, 7.4],
        ['ist kalt\n', 7.4, 8.0],
        ['Ein Cursor blinkt\n', 9.5, 11.0],
        ['[Chorus]\n', 11.0, 11.1, false],
        ['KI statt Gute Nacht\n', 14.0, 16.0],
        ['KI statt Gute Nacht\n', 18.0, 20.0],
      ]),
    );
    expect(result.synced).toBe(true);
    expect(result.lines).toEqual([
      { kind: 'section', label: 'Verse 1' },
      { kind: 'line', text: 'Halb zwei, der Kaffee ist kalt!', timeSeconds: 6.0 },
      { kind: 'line', text: 'Ein Cursor blinkt', timeSeconds: 9.5 },
      { kind: 'section', label: 'Chorus' },
      { kind: 'line', text: 'KI statt Gute Nacht', timeSeconds: 14.0 },
      { kind: 'line', text: 'KI statt Gute Nacht', timeSeconds: 18.0 },
    ]);
  });

  it('falls back to unsynced (all times null) when too few lines can be matched', () => {
    const result = buildLyricLines(
      TEXT,
      timed([
        ['completely ', 1, 2],
        ['different ', 2, 3],
        ['words\n', 3, 4],
        ['Ein Cursor blinkt\n', 9.5, 11.0],
      ]),
    );
    expect(result.synced).toBe(false);
    for (const line of result.lines) {
      if (line.kind === 'line') expect(line.timeSeconds).toBeNull();
    }
  });

  it('distrusts the timing wholesale when the provider reports poor alignment', () => {
    const poorAlignment: TimedLyrics = {
      words: [{ word: 'Ein Cursor blinkt\n', startSeconds: 9.5, endSeconds: 11, success: true }],
      alignmentErrorScore: 0.9,
    };
    const result = buildLyricLines('Ein Cursor blinkt', poorAlignment);
    expect(result.synced).toBe(false);
    expect(result.lines).toEqual([{ kind: 'line', text: 'Ein Cursor blinkt', timeSeconds: null }]);
  });

  it('drops a non-monotonic line time instead of scrolling backwards', () => {
    const result = buildLyricLines(
      ['One two three', 'Four five six', 'Seven eight nine'].join('\n'),
      timed([
        ['One two three\n', 10, 12],
        ['Four five six\n', 2, 3], // provider glitch: earlier than the previous line
        ['Seven eight nine\n', 14, 15],
      ]),
    );
    expect(result.lines).toEqual([
      { kind: 'line', text: 'One two three', timeSeconds: 10 },
      { kind: 'line', text: 'Four five six', timeSeconds: null },
      { kind: 'line', text: 'Seven eight nine', timeSeconds: 14 },
    ]);
    expect(result.synced).toBe(true);
  });
});
