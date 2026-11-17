// A Surprise Me suggestion in words, as its preview shows it: on Home's
// Surprise Me and on the Assistant's card for one.

import type { SurpriseProposal } from '@liedmotif/shared';
import { genreLabel } from './genre-vocabulary';

type SurprisePreview = Pick<
  SurpriseProposal,
  'adventurous' | 'genres' | 'mood' | 'energy' | 'vocalMode' | 'language' | 'voiceGender'
>;

const ENERGY_LABELS = { low: 'Low energy', medium: 'Medium energy', high: 'High energy' } as const;
const VOICE_LABELS = { female: 'Female voice', male: 'Male voice' } as const;

export const surpriseExploreLabel = (preview: Pick<SurprisePreview, 'adventurous'>) =>
  preview.adventurous ? 'Adventurous' : 'Familiar';

export function surpriseVibeLine(preview: SurprisePreview): string {
  return [
    preview.genres.map(genreLabel).join(', '),
    preview.mood.trim(),
    ENERGY_LABELS[preview.energy],
  ]
    .filter(Boolean)
    .join(' · ');
}

export function surpriseVocalLine(preview: SurprisePreview): string {
  if (preview.vocalMode === 'instrumental') return 'Instrumental';
  return [
    'Vocals',
    preview.language,
    preview.voiceGender ? VOICE_LABELS[preview.voiceGender] : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
