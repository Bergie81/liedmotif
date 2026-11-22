// UI vocabulary for the cover-style choices (client-safe, no server imports).
// Labels cover every `CoverStyleChoice`; each surface renders the choice list its
// contract pins (e.g. `COVER_STYLE_CHOICES`, `Auto` first and `Custom` last) through
// these labels, so the surfaces can never disagree on an option's wording.

import type { CoverStyleChoice } from '@liedmotif/shared';

export const COVER_STYLE_LABELS: Record<CoverStyleChoice, string> = {
  auto: 'Auto',
  random: 'Random',
  record_sleeve: 'Record Sleeve',
  poster_art: 'Artistic',
  photographic: 'Photographic',
  manga: 'Manga',
  drawing: 'Drawing',
  minimal: 'Minimal',
  custom: 'Custom',
};

/** One line per choice saying what the style does, shown under its label in the picker. */
export const COVER_STYLE_EXPLANATIONS: Record<CoverStyleChoice, string> = {
  auto: 'Picks the style that fits each session.',
  random: 'A different style for every session.',
  record_sleeve: 'An album cover from one decade, 1960s to 2000s.',
  poster_art: 'Bold graphic artwork around one strong visual idea.',
  photographic: 'A believable photo of one real moment.',
  manga: 'Black-and-white manga ink with expressive characters.',
  drawing: 'A hand-made pencil or ink drawing on paper.',
  minimal: 'One motif, lots of empty space, two or three flat colors.',
  custom: 'Your own style, written below.',
};
