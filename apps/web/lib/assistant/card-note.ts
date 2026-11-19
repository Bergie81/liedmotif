// A card as the model reads it. The tool that prepared the card answers with
// this wording, and the chat panel sends it back with the answer the card
// came in, so the model reads one wording of a card in the turn that offered
// it and in every later one. Plain text, safe to import from the browser.

import type { AssistantCard } from '@liedmotif/shared';
import { quoted } from './music-names';

/** How much music New music on may make, as the model reads it; null minutes is No limit. */
export const newMusicLimitNote = (targetMinutes: number | null) =>
  targetMinutes === null ? 'with no limit' : `up to ${targetMinutes} minutes of music`;

/** A new Session's length as the model reads it; null minutes is No limit, none is left out. */
const lengthNote = (minutes: number | null | undefined) =>
  minutes === null
    ? newMusicLimitNote(null)
    : minutes === undefined
      ? undefined
      : `${minutes} minutes`;

/** What the card offers to do, with the values the confirmation sends. */
export function cardNote(card: AssistantCard): string {
  switch (card.kind) {
    case 'session': {
      const details = [card.vocal === 'vocal' ? 'with vocals' : 'instrumental'];
      const length = lengthNote(card.targetDurationMinutes);
      if (length) details.push(length);
      return `start a new Session from ${quoted(card.prompt)}, ${details.join(', ')}`;
    }
    case 'changeVibe':
      return `change the vibe of the Session ${quoted(card.session.name)} with the words ${quoted(card.prompt)}`;
    case 'moreLikeThis': {
      const titles = card.tracks.map(({ name }) => quoted(name)).join(', ');
      const length = lengthNote(card.targetDurationMinutes);
      return `start a new Session that sounds like the ${card.tracks.length === 1 ? 'Track' : 'Tracks'} ${titles}${length ? `, ${length}` : ''}`;
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
 * on the card, being made the cover, the cover, or gone from the history. Or
 * that the app no longer tells: a later attempt came first (`unknown`), or the
 * Session or Playlist can no longer be read (`gone`).
 */
export type CoverAttemptState =
  'generating' | 'ready' | 'using' | 'inUse' | 'deleted' | 'failed' | 'unknown' | 'gone';

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
  unknown:
    'The user confirmed it, but a later cover attempt came after it, so the app no longer tells how this one went. If it was generated, it is in the cover history.',
  gone: 'The user confirmed it, but the app can no longer read the covers it was for, and the card told them why.',
};

function became(outcome?: CardOutcome, cover?: CoverAttemptState): string {
  if (!outcome) return LEFT_ALONE;
  if (outcome === 'confirmed' && cover) return COVER_BECAME[cover];
  return BECAME[outcome];
}

/**
 * What a later turn is told about a card: what it offered, and what the user
 * did with it. A confirmed cover card says how its cover is going.
 */
export const cardRecord = (card: AssistantCard, outcome?: CardOutcome, cover?: CoverAttemptState) =>
  `[Card shown by the app: ${cardNote(card)}. ${became(outcome, cover)}]`;
