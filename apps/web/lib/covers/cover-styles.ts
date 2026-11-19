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
