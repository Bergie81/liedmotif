import { describe, expect, it } from 'vitest';
import { SESSION_LANGUAGES } from './domain';
import {
  DEFAULT_GENERATION_SETTINGS,
  defaultSessionMode,
  generationSettingsSchema,
  updateGenerationSettingsRequestSchema,
} from './generation-settings';

describe('SESSION_LANGUAGES', () => {
  it('offers English plus the curated set, without an auto sentinel', () => {
    expect(SESSION_LANGUAGES).toContain('English');
    expect(SESSION_LANGUAGES).toContain('German');
    expect(SESSION_LANGUAGES).toContain('Norwegian');
    expect(SESSION_LANGUAGES).not.toContain('auto');
    expect(SESSION_LANGUAGES).toHaveLength(23);
  });

  it('lists the non-English languages alphabetically after English', () => {
    const [first, ...rest] = SESSION_LANGUAGES;
    expect(first).toBe('English');
    expect([...rest].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(rest);
  });
});

describe('generationSettingsSchema.defaultLanguage', () => {
  it('ships with auto-detect as the default', () => {
    expect(DEFAULT_GENERATION_SETTINGS.defaultLanguage).toBe('auto');
    expect(generationSettingsSchema.parse(DEFAULT_GENERATION_SETTINGS)).toEqual(
      DEFAULT_GENERATION_SETTINGS,
    );
  });

  it('accepts auto and every curated language', () => {
    for (const language of ['auto', ...SESSION_LANGUAGES]) {
      const parsed = generationSettingsSchema.parse({
        bufferEnabled: true,
        bufferAheadTracks: 3,
        defaultLanguage: language,
      });
      expect(parsed.defaultLanguage).toBe(language);
    }
  });

  it('rejects values outside the curated vocabulary', () => {
    for (const invalid of ['Klingon', 'german', '']) {
      expect(
        generationSettingsSchema.safeParse({
          bufferEnabled: true,
          bufferAheadTracks: 3,
          defaultLanguage: invalid,
        }).success,
      ).toBe(false);
    }
  });

  it('patches independently of bufferAheadTracks', () => {
    expect(updateGenerationSettingsRequestSchema.parse({ defaultLanguage: 'German' })).toEqual({
      defaultLanguage: 'German',
    });
  });
});

describe('generationSettingsSchema.Buffer', () => {
  it('ships enabled with a three-Track target', () => {
    expect(DEFAULT_GENERATION_SETTINGS).toMatchObject({
      bufferEnabled: true,
      bufferAheadTracks: 3,
    });
  });

  it.each([1, 3, 10])('accepts the enabled target %i', (bufferAheadTracks) => {
    expect(
      generationSettingsSchema.safeParse({
        bufferEnabled: true,
        bufferAheadTracks,
        defaultLanguage: 'auto',
      }).success,
    ).toBe(true);
  });

  it.each([0, 11, 2.5])('rejects the target %s', (bufferAheadTracks) => {
    expect(
      generationSettingsSchema.safeParse({
        bufferEnabled: false,
        bufferAheadTracks,
        defaultLanguage: 'auto',
      }).success,
    ).toBe(false);
  });

  it('patches enabled state independently of the retained target', () => {
    expect(updateGenerationSettingsRequestSchema.parse({ bufferEnabled: false })).toEqual({
      bufferEnabled: false,
    });
  });
});

describe('defaultSessionMode', () => {
  it('starts new Sessions generating while the Buffer default is on', () => {
    expect(defaultSessionMode({ bufferEnabled: true })).toBe('keep_going');
  });

  it('starts new Sessions on their existing Tracks while the default is off', () => {
    expect(defaultSessionMode({ bufferEnabled: false })).toBe('repeat');
  });
});
