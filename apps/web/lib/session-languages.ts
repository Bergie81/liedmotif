// UI vocabulary for the session-language choices (client-safe, no server
// imports). Both selects (Settings → Generation and the create card's Fine Tune
// fold) render `SESSION_LANGUAGE_CHOICES` so the surfaces can never disagree on
// options or order: Auto Detect first, then English, then the rest A–Z (the
// order `SESSION_LANGUAGES` already pins).

import { SESSION_LANGUAGES, type GenerationSettings } from '@liedmotif/shared';

/** A concrete language pick, or `'auto'` = detect from the create prompt. */
export type SessionLanguageChoice = GenerationSettings['defaultLanguage'];

export const SESSION_LANGUAGE_CHOICES = ['auto', ...SESSION_LANGUAGES] as const;

export function sessionLanguageLabel(choice: SessionLanguageChoice): string {
  if (choice === 'auto') return 'Auto Detect';
  if (choice === 'Chinese') return 'Chinese (Mandarin)';
  return choice;
}
