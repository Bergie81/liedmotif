import { describe, expect, it } from 'vitest';
import { SESSION_LANGUAGES } from './domain';
import {
  DEFAULT_GENERATION_SETTINGS,
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
        ...DEFAULT_GENERATION_SETTINGS,
        defaultLanguage: language,
      });
      expect(parsed.defaultLanguage).toBe(language);
    }
  });

  it('rejects values outside the curated vocabulary', () => {
    for (const invalid of ['Klingon', 'german', '']) {
      expect(
        generationSettingsSchema.safeParse({
          ...DEFAULT_GENERATION_SETTINGS,
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
  it('ships with a three-Track target', () => {
    expect(DEFAULT_GENERATION_SETTINGS.bufferAheadTracks).toBe(3);
  });

  it.each([1, 3, 10])('accepts the target %i', (bufferAheadTracks) => {
    expect(
      generationSettingsSchema.safeParse({ ...DEFAULT_GENERATION_SETTINGS, bufferAheadTracks })
        .success,
    ).toBe(true);
  });

  it.each([0, 11, 2.5])('rejects the target %s', (bufferAheadTracks) => {
    expect(
      generationSettingsSchema.safeParse({ ...DEFAULT_GENERATION_SETTINGS, bufferAheadTracks })
        .success,
    ).toBe(false);
  });

  it('holds no Buffer on/off switch', () => {
    expect(DEFAULT_GENERATION_SETTINGS).not.toHaveProperty('bufferEnabled');
    expect(updateGenerationSettingsRequestSchema.safeParse({ bufferEnabled: false }).success).toBe(
      false,
    );
  });
});

describe('generationSettingsSchema.defaultSessionDurationMinutes', () => {
  it('ships at 30 minutes', () => {
    expect(DEFAULT_GENERATION_SETTINGS.defaultSessionDurationMinutes).toBe(30);
  });

  it.each([5, 15, 30, 60, 120, null])('accepts %s', (defaultSessionDurationMinutes) => {
    expect(updateGenerationSettingsRequestSchema.parse({ defaultSessionDurationMinutes })).toEqual({
      defaultSessionDurationMinutes,
    });
  });

  it.each([0, 10, 45, 90, 180, 600, 30.5, '30'])('refuses %s', (defaultSessionDurationMinutes) => {
    expect(
      updateGenerationSettingsRequestSchema.safeParse({ defaultSessionDurationMinutes }).success,
    ).toBe(false);
  });
});
