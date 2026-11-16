// The settings the Assistant changes, as the app names them: the label the
// settings page shows for each, and the page it is on. Plain text, safe to
// import from the browser.

import type { AssistantSetting } from '@liedmotif/shared';

export const SETTING_NAMES: Record<AssistantSetting, { label: string; page: string }> = {
  ownerInCovers: { label: 'Include the owner in Covers', page: '/settings/people' },
  blend: { label: 'Blend consecutive Tracks', page: '/settings/playback' },
  crossfadeSeconds: { label: 'Crossfade length', page: '/settings/playback' },
  defaultLanguage: { label: 'Default language', page: '/settings/generation' },
};
