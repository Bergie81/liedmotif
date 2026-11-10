// A card as the model reads it. The tool that prepared the card answers with
// this wording, and the chat panel sends it back with the answer the card
// came in, so the model reads one wording of a card in the turn that offered
// it and in every later one. Plain text, safe to import from the browser.

import type { AssistantCard } from '@liedmotif/shared';
import { quoted } from './music-names';

/** What the card offers to do, with the values the confirmation sends. */
export function cardNote(card: AssistantCard): string {
  switch (card.kind) {
    case 'session': {
      const sound = card.vocal === 'vocal' ? 'with vocals' : 'instrumental';
      const length =
        card.targetDurationMinutes === undefined ? '' : `, ${card.targetDurationMinutes} minutes`;
      return `start a new Session from ${quoted(card.prompt)}, ${sound}${length}`;
    }
    case 'changeVibe':
      return `change the vibe of the Session ${quoted(card.session.name)} with the words ${quoted(card.prompt)}`;
    case 'moreLikeThis': {
      const titles = card.tracks.map(({ name }) => quoted(name)).join(', ');
      return `start a new Session that sounds like the ${card.tracks.length === 1 ? 'Track' : 'Tracks'} ${titles}`;
    }
    case 'newMusicOn': {
      const limit =
        card.targetDurationMinutes === null
          ? 'with no limit'
          : `up to ${card.targetDurationMinutes} minutes of music`;
      return `switch New music on for the Session ${quoted(card.session.name)}, ${limit}`;
    }
  }
}

/**
 * What became of a card once the user confirmed it: `confirming` while the
 * app's own route is asked, then `confirmed` or `failed` for good. A card is
 * confirmed at most once; until then it has no outcome and waits for the user.
 */
export type CardOutcome = 'confirming' | 'confirmed' | 'failed';

const LEFT_ALONE = 'The user has not confirmed it, so it has not happened.';

const BECAME: Record<CardOutcome, string> = {
  confirming: 'The user confirmed it, and the app is carrying it out.',
  confirmed: 'The user confirmed it, and the app carried it out.',
  failed: 'The user confirmed it, but the app did not carry it out and told them why.',
};

/** What a later turn is told about a card: what it offered, and what the user did with it. */
export const cardRecord = (card: AssistantCard, outcome?: CardOutcome) =>
  `[Card shown by the app: ${cardNote(card)}. ${outcome ? BECAME[outcome] : LEFT_ALONE}]`;
