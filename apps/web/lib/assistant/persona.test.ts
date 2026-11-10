import { describe, expect, it } from 'vitest';
import { assistantToneSchema } from '@liedmotif/shared';
import { TONE_PRESETS } from './persona';

describe('the ready-made tones', () => {
  it.each(TONE_PRESETS)('$label is a tone the settings route saves as written', ({ tone }) => {
    expect(assistantToneSchema.parse({ tone })).toEqual({ tone });
  });
});
