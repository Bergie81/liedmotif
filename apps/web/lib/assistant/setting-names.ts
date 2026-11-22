// The settings the Assistant changes, as the app names them: the label the
// settings page shows for each, and the page it is on. Plain text, safe to
// import from the browser.

import { ASSISTANT_SETTINGS, type AssistantSetting } from '@liedmotif/shared';

export const SETTING_NAMES: Record<AssistantSetting, { label: string; page: string }> = {
  ownerInCovers: { label: 'Include the owner in covers', page: '/settings/people' },
  blend: { label: 'Blend consecutive tracks', page: '/settings/playback' },
  crossfadeSeconds: { label: 'Crossfade length', page: '/settings/playback' },
  defaultLanguage: { label: 'Default language', page: '/settings/generation' },
  defaultSessionDuration: { label: 'New music per Session', page: '/settings/generation' },
};

/** `words` as one list: "a, b or c". */
export const orList = (words: readonly string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : (words[0] ?? '');

/** Every setting the Assistant changes, by its label: "A, B or C". */
export const SETTING_LABELS_LIST = orList(
  ASSISTANT_SETTINGS.map((name) => SETTING_NAMES[name].label),
);
