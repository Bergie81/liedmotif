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

/** One stream word per sung word, starting at `startSeconds`, one second apart. */
function sung(text: string, startSeconds: number): Array<[string, number, number]> {
  return text
    .split(' ')
    .map((word, i): [string, number, number] => [
      `${word} `,
      startSeconds + i,
      startSeconds + i + 1,
    ]);
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

  it('a section tag never binds inside a sung word', () => {
    const result = buildLyricLines(
      [
        '[Verse]',
        'Walking through the rain tonight',
        'Cold streets under my feet',
        '[Break]',
        'Falling down again',
        'Another heartbreak on the way',
      ].join('\n'),
      timed([
        ...sung('Walking through the rain tonight', 10),
        ...sung('Cold streets under my feet', 20),
        ...sung('Falling down again', 40),
        ...sung('Another heartbreak on the way', 50),
      ]),
    );
    expect(result.synced).toBe(true);
    expect(result.lines).toEqual([
      { kind: 'section', label: 'Verse' },
      { kind: 'line', text: 'Walking through the rain tonight', timeSeconds: 10 },
      { kind: 'line', text: 'Cold streets under my feet', timeSeconds: 20 },
      { kind: 'section', label: 'Break' },
      { kind: 'line', text: 'Falling down again', timeSeconds: 40 },
      { kind: 'line', text: 'Another heartbreak on the way', timeSeconds: 50 },
    ]);
  });

  it('a skipped short line stays untimed instead of binding far ahead', () => {
    const result = buildLyricLines(
      [
        'Walking through the rain tonight',
        'Yeah yeah',
        'Cold streets under my feet',
        'Lights are fading out of view',
        'Yeah yeah, we are free',
      ].join('\n'),
      timed([
        ...sung('Walking through the rain tonight', 10),
        ...sung('Cold streets under my feet', 20),
        ...sung('Lights are fading out of view', 30),
        ...sung('Yeah yeah we are free', 40),
      ]),
    );
    expect(result.synced).toBe(true);
    expect(result.lines).toEqual([
      { kind: 'line', text: 'Walking through the rain tonight', timeSeconds: 10 },
      { kind: 'line', text: 'Yeah yeah', timeSeconds: null },
      { kind: 'line', text: 'Cold streets under my feet', timeSeconds: 20 },
      { kind: 'line', text: 'Lights are fading out of view', timeSeconds: 30 },
      { kind: 'line', text: 'Yeah yeah, we are free', timeSeconds: 40 },
    ]);
  });

  it('a line missed before a repeated chorus does not take the chorus', () => {
    const result = buildLyricLines(
      [
        'Walking through the rain tonight',
        '(Let it go)',
        '[Chorus]',
        'Hold on to the light',
        'Never let it go',
        '[Chorus]',
        'Hold on to the light',
        'Never let it go',
      ].join('\n'),
      timed([
        ...sung('Walking through the rain tonight', 10),
        ...sung('Hold on to the light', 20),
        ...sung('Never let it go', 30),
        ...sung('Hold on to the light', 60),
        ...sung('Never let it go', 70),
      ]),
    );
    expect(result.synced).toBe(true);
    expect(result.lines).toEqual([
      { kind: 'line', text: 'Walking through the rain tonight', timeSeconds: 10 },
      { kind: 'line', text: '(Let it go)', timeSeconds: null },
      { kind: 'section', label: 'Chorus' },
      { kind: 'line', text: 'Hold on to the light', timeSeconds: 20 },
      { kind: 'line', text: 'Never let it go', timeSeconds: 30 },
      { kind: 'section', label: 'Chorus' },
      { kind: 'line', text: 'Hold on to the light', timeSeconds: 60 },
      { kind: 'line', text: 'Never let it go', timeSeconds: 70 },
    ]);
  });

  it('a short line right after a provider section marker still binds', () => {
    const result = buildLyricLines(
      ['Walking through the rain tonight', '[Chorus]', 'Oh yeah', 'Hold on to the light'].join(
        '\n',
      ),
      timed([
        ...sung('Walking through the rain tonight', 10),
        ['[Chorus]\n', 15, 15.1, false],
        ...sung('Oh yeah', 20),
        ...sung('Hold on to the light', 25),
      ]),
    );
    expect(result.lines).toEqual([
      { kind: 'line', text: 'Walking through the rain tonight', timeSeconds: 10 },
      { kind: 'section', label: 'Chorus' },
      { kind: 'line', text: 'Oh yeah', timeSeconds: 20 },
      { kind: 'line', text: 'Hold on to the light', timeSeconds: 25 },
    ]);
  });

  it('the line after a long instrumental break is still timed, short or not', () => {
    for (const second of ['Cold streets under my feet', 'Oh yeah']) {
      const result = buildLyricLines(
        ['Walking through the rain tonight', second].join('\n'),
        timed([...sung('Walking through the rain tonight', 10), ...sung(second, 190)]),
      );
      expect(result.synced).toBe(true);
      expect(result.lines).toEqual([
        { kind: 'line', text: 'Walking through the rain tonight', timeSeconds: 10 },
        { kind: 'line', text: second, timeSeconds: 190 },
      ]);
    }
  });
});
