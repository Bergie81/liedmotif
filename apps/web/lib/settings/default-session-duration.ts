// The Default Session duration as Settings → Generation names its choices. The
// settings form, the settings hub and onboarding word it from here, so they
// cannot name one choice differently.

import { DEFAULT_SESSION_DURATION_CHOICES, type GenerationSettings } from '@liedmotif/shared';

export type DefaultSessionDuration = GenerationSettings['defaultSessionDurationMinutes'];

/** Every choice in the order the settings page shows them; null is No limit. */
export const DEFAULT_SESSION_DURATION_OPTIONS: readonly DefaultSessionDuration[] = [
  ...DEFAULT_SESSION_DURATION_CHOICES,
  null,
];

/** A choice as the settings page shows it: "5 min", "1 h", "No limit". */
export function defaultSessionDurationLabel(minutes: DefaultSessionDuration): string {
  if (minutes === null) return 'No limit';
  return minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`;
}
