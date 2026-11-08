import { describe, expect, it } from 'vitest';
import { deriveSessionTitle, MAX_SESSION_TITLE_LENGTH } from './session-title';
import { compileStructuredControls } from './template';

describe('deriveSessionTitle', () => {
  it('prefers an LLM-proposed snapshot title over everything else', () => {
    expect(
      deriveSessionTitle({
        userPrompt: 'chill lofi for studying',
        snapshot: { title: '  Midnight Pages  ', mood: 'calm' },
      }),
    ).toBe('Midnight Pages');
  });

  it('clamps an overlong proposed title at a word boundary', () => {
    const title = deriveSessionTitle({
      snapshot: { title: 'An Exceptionally Long And Winding Session Name That Never Ends At All' },
    });
    expect(title.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
  });

  it('names a free-text session after the prompt itself, capitalized', () => {
    expect(
      deriveSessionTitle({ userPrompt: 'upbeat synthwave for late night coding', snapshot: {} }),
    ).toBe('Upbeat synthwave for late night coding');
  });

  it('collapses whitespace and truncates a long prompt at a word boundary', () => {
    const title = deriveSessionTitle({
      userPrompt:
        'some   very calm and extremely relaxing ambient music,\nperfect for reading a dense book on a rainy sunday afternoon',
      snapshot: {},
    });
    expect(title.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('  ');
    // Never cut mid-word, and no dangling punctuation before the ellipsis.
    expect(title).toBe('Some very calm and extremely relaxing ambient music…');
  });

  it('composes a structured-controls name from mood, activity, and genres', () => {
    const snapshot = compileStructuredControls({
      mood: 'calm',
      activity: 'deep focus',
      genres: ['lo-fi', 'ambient', 'jazz'],
    });
    expect(deriveSessionTitle({ snapshot })).toBe('Calm Deep Focus · Lo-Fi, Ambient');
  });

  it('falls back to energy + vocal mode for empty default controls', () => {
    const snapshot = compileStructuredControls({});
    expect(deriveSessionTitle({ snapshot })).toBe('Medium Energy Instrumental');
  });

  it('always returns a non-empty title even for a bare snapshot', () => {
    expect(deriveSessionTitle({ snapshot: {} })).toBe('Instrumental Session');
    expect(deriveSessionTitle({ userPrompt: '   ', snapshot: {} })).toBe('Instrumental Session');
  });
});
