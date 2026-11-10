// The New music choices in the player's words. The New music sheet offers
// them, and a card in the Assistant's chat that switches New music on is
// worded from the same text, so the two cannot name one choice differently.

export type NewMusicChoice = 'off' | 'target' | 'no-limit';

export const NEW_MUSIC_CHOICES: Record<NewMusicChoice, { label: string; detail: string }> = {
  off: { label: 'Off', detail: 'Play the Tracks you have. Buys nothing on its own.' },
  target: { label: 'Up to a duration', detail: 'Buys music until the target.' },
  'no-limit': { label: 'No limit', detail: 'Keeps buying while you listen.' },
};

/** The button that saves a choice that can spend; `null` minutes is No limit. */
export const newMusicSaveLabel = (targetMinutes: number | null) =>
  targetMinutes === null ? 'Save · no limit' : `Save · up to ${targetMinutes} min`;

export const NEW_MUSIC_SAVING = 'Saving…';
