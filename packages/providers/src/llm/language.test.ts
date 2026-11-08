import { describe, expect, it } from 'vitest';
import { SESSION_LANGUAGES } from '@liedmotif/shared';
import { sanitizeLanguage } from './language';

describe('sanitizeLanguage', () => {
  // The create-screen vocabulary must survive the provider-side allowlist:
  // a pick that sanitized to '' would silently drop the user's language.
  it('accepts every SESSION_LANGUAGES pick unchanged', () => {
    for (const language of SESSION_LANGUAGES) {
      expect(sanitizeLanguage(language)).toBe(language);
    }
  });

  it('drops off-list and injected values to the empty tag', () => {
    expect(sanitizeLanguage('German exactly like Adele')).toBe('');
    expect(sanitizeLanguage('auto')).toBe('');
  });
});
