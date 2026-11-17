// A card as the model reads it. The tool that prepared the card answers with
// this wording, and the chat panel sends it back with the answer the card
// came in, so the model reads one wording of a card in the turn that offered
// it and in every later one. Plain text, safe to import from the browser.

import type { AssistantCard } from '@liedmotif/shared';
import { quoted } from './music-names';

/** How much music New music on may make, as the model reads it; null minutes is No limit. */
export const newMusicLimitNote = (targetMinutes: number | null) =>
  targetMinutes === null ? 'with no limit' : `up to ${targetMinutes} minutes of music`;

/** What the card offers to do, with the values the confirmation sends. */
export function cardNote(card: AssistantCard): string {
  switch (card.kind) {
    case 'session': {
      const minutes = card.targetDurationMinutes;
      const details = [card.vocal === 'vocal' ? 'with vocals' : 'instrumental'];
      if (minutes === null) details.push(newMusicLimitNote(null));
      else if (minutes !== undefined) details.push(`${minutes} minutes`);
      return `start a new Session from ${quoted(card.prompt)}, ${details.join(', ')}`;
    }
    case 'changeVibe':
      return `change the vibe of the Session ${quoted(card.session.name)} with the words ${quoted(card.prompt)}`;
    case 'moreLikeThis': {
      const titles = card.tracks.map(({ name }) => quoted(name)).join(', ');
      return `start a new Session that sounds like the ${card.tracks.length === 1 ? 'Track' : 'Tracks'} ${titles}`;
    }
    case 'newMusicOn':
      return `switch New music on for the Session ${quoted(card.session.name)}, ${newMusicLimitNote(card.targetDurationMinutes)}`;
    case 'surprise': {
      const { suggestion } = card;
      const minutes = card.targetDurationMinutes;
      const details = [
        `mood ${quoted(suggestion.mood)}`,
        suggestion.vocalMode === 'vocal' ? 'with vocals' : 'instrumental',
        minutes === null ? newMusicLimitNote(null) : `${minutes} minutes`,
      ];
      return `start the Surprise Me suggestion ${quoted(suggestion.title)} as a new Session, ${details.join(', ')}`;
    }
    case 'cover': {
      const { subject, guidance } = card;
      const direction = guidance === undefined ? '' : ` with the art direction ${quoted(guidance)}`;
      return `generate one new cover for the ${subject.kind === 'session' ? 'Session' : 'Playlist'} ${quoted(subject.name)}${direction}`;
    }
  }
}

/** What confirming the card spends, as the model tells the user. */
export const cardCost = (card: AssistantCard) =>
  card.kind === 'cover'
    ? 'confirming generates one cover from their cover budget'
    : 'confirming generates new Tracks from their budget';

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

/**
 * How the cover a confirmed cover card asked for is going: generated, offered
 * on the card, being made the cover, the cover, or gone from the history.
 */
export type CoverAttemptState = 'generating' | 'ready' | 'using' | 'inUse' | 'deleted' | 'failed';

// A generated cover is never applied on its own: only the card's second tap makes it the cover.
const COVER_BECAME: Record<CoverAttemptState, string> = {
  generating:
    'The user confirmed it, and the app is generating the cover. It becomes the cover only if the user picks it on the card.',
  ready:
    'The user confirmed it, and the new cover is ready on the card. The user has not used it, so the current cover stays and the new one is in the cover history.',
  using:
    'The user confirmed it and chose to use the new cover, and the app is making it the cover.',
  inUse: 'The user confirmed it and used the new cover, so it is the cover now.',
  deleted:
    'The user confirmed it, and the new cover was generated but has since been deleted from the cover history.',
  failed: 'The user confirmed it, but the cover failed to generate, and the card told them why.',
};

/**
 * What a later turn is told about a card: what it offered, and what the user
 * did with it. A confirmed cover card says how its cover is going.
 */
export const cardRecord = (card: AssistantCard, outcome?: CardOutcome, cover?: CoverAttemptState) =>
  `[Card shown by the app: ${cardNote(card)}. ${
    outcome === 'confirmed' && cover ? COVER_BECAME[cover] : outcome ? BECAME[outcome] : LEFT_ALONE
  }]`;
