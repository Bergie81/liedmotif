import { describe, expect, it } from 'vitest';
import { cutSnippet } from './snippet';

const WORDS = Array.from({ length: 60 }, (_, i) => `word${i}`);

describe('cutSnippet', () => {
  it('returns text shorter than the window untouched', () => {
    expect(cutSnippet('gentle rain textures', 'rain')).toBe('gentle rain textures');
  });

  it('collapses whitespace runs so a lyric body reads as one line', () => {
    expect(cutSnippet('first line\n  second\tline', 'second')).toBe('first line second line');
  });

  it('keeps a match at the start flush-left with a trailing ellipsis', () => {
    const text = `needle ${WORDS.join(' ')}`;
    const snippet = cutSnippet(text, 'needle');
    expect(snippet.startsWith('needle')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('windows a mid-text match with ellipses on both sides', () => {
    const text = `${WORDS.slice(0, 30).join(' ')} needle ${WORDS.slice(30).join(' ')}`;
    const snippet = cutSnippet(text, 'needle');
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(104);
  });

  it('reaches a match at the end of the text without a trailing ellipsis', () => {
    const text = `${WORDS.join(' ')} needle`;
    const snippet = cutSnippet(text, 'needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('needle')).toBe(true);
  });

  it('finds the match case-insensitively', () => {
    const text = `${WORDS.slice(0, 30).join(' ')} NeeDLe ${WORDS.slice(30).join(' ')}`;
    expect(cutSnippet(text, 'needle')).toContain('NeeDLe');
  });

  it('shows the head of a match longer than the window', () => {
    const long = `start-of-the-match ${WORDS.join(' ')}`;
    const text = `${WORDS.join(' ')} ${long}`;
    const snippet = cutSnippet(text, long);
    expect(snippet).toContain('start-of-the-match');
  });

  it('falls back to the head of the text when the query is absent', () => {
    const text = WORDS.join(' ');
    const snippet = cutSnippet(text, 'absent-needle');
    expect(snippet.startsWith('word0')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('never cuts through a surrogate pair', () => {
    const emoji = '🎵'.repeat(120);
    const snippet = cutSnippet(`needle ${emoji}`, 'needle');
    const loneSurrogate = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    expect(loneSurrogate.test(snippet)).toBe(false);
  });
});
