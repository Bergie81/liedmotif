// A card in words: what the chat shows for something the Assistant prepared
// and the user may confirm. It is written here from the structured values the
// confirmation sends; the model's own text is never part of it.

import type { AssistantAction, AssistantCard } from '@liedmotif/shared';
import {
  NEW_MUSIC_CHOICES,
  NEW_MUSIC_SAVING,
  newMusicSaveLabel,
} from '@/components/player/new-music-choices';
import {
  surpriseExploreLabel,
  surpriseVibeLine,
  surpriseVocalLine,
} from '@/components/create/surprise-preview-lines';
import type { CardOutcome, CoverAttemptState } from '@/lib/assistant/card-note';
import { playlistName, sessionTitle, trackTitle } from './receipt';

/** A card as the chat holds it. Without an outcome it is offered and waits for the user. */
export type ProposedChatAction = Extract<AssistantAction, { status: 'proposed' }> & {
  outcome?: CardOutcome;
} & CardOutcomeFacts;

/** What the app told of a card's outcome, kept with the card. */
export interface CardOutcomeFacts {
  /** Why the app did not carry it out, in the app's words, when the card is where that shows. */
  refusal?: string;
  /** The cover attempt a confirmed cover card asked for, so the card can read how it is going. */
  coverGenerationId?: string;
  /** How that attempt is going, as the cover status route last told it. */
  cover?: CoverAttempt;
}

/**
 * The cover attempt of a confirmed cover card. Its cover is known from the
 * first read, so the card still finds it once a later attempt is the latest.
 */
export type CoverAttempt =
  | {
      state: Exclude<CoverAttemptState, 'ready' | 'failed' | 'unknown' | 'gone'>;
      coverImageId: string;
    }
  /** `refusal`: why the cover select request did not make it the cover, in the app's words. */
  | { state: 'ready'; coverImageId: string; refusal?: string }
  | { state: 'failed'; failure: string | null }
  | { state: 'unknown' }
  /** `refusal`: why the cover status route will not answer, in the app's words. */
  | { state: 'gone'; refusal: string };

export interface CardWording {
  /** What confirming does. */
  title: string;
  /** The name of what it starts, when it has one before it starts. */
  name?: string;
  /** The words the request carries, shown as a quote; left out when it carries none. */
  words?: string;
  /** What else the request carries, in the app's own labels. */
  details: string;
  /** What confirming costs, in one sentence. */
  cost: string;
  /** The button, and what it says while the app's route is asked. */
  confirm: string;
  confirming: string;
  /** What the card says for good once it was confirmed. */
  confirmed: string;
  failed: string;
}

/** A new Session's length as its card shows it; null minutes is No limit, none is left out. */
function lengthLabel(minutes: number | null | undefined): string | undefined {
  if (minutes === null) return NEW_MUSIC_CHOICES['no-limit'].label;
  if (minutes === undefined) return undefined;
  return `${minutes} min`;
}

export function cardWording(card: AssistantCard): CardWording {
  switch (card.kind) {
    case 'session': {
      const details = [card.vocal === 'vocal' ? 'With vocals' : 'Instrumental'];
      const length = lengthLabel(card.targetDurationMinutes);
      if (length) details.push(length);
      return {
        title: 'Start a New Session',
        words: card.prompt,
        details: details.join(' · '),
        cost: 'Starting generates new tracks from your budget.',
        confirm: 'Start Session',
        confirming: 'Starting…',
        confirmed: 'Session started',
        failed: 'This session did not start',
      };
    }
    case 'changeVibe':
      return {
        title: 'Change Vibe',
        words: card.prompt,
        details: `In ${sessionTitle(card.session)}`,
        cost: 'Changing the vibe generates new tracks from your budget.',
        confirm: 'Change Vibe',
        confirming: 'Changing…',
        confirmed: 'Vibe changed',
        failed: 'The vibe did not change',
      };
    case 'moreLikeThis': {
      const titles = card.tracks.map(trackTitle).join(', ');
      const details = [
        `A new session seeded from ${
          card.tracks.length === 1 ? titles : `${card.tracks.length} tracks: ${titles}`
        }`,
      ];
      const length = lengthLabel(card.targetDurationMinutes);
      if (length) details.push(length);
      return {
        title: 'More Like This',
        details: details.join(' · '),
        cost: 'Starting generates new tracks from your budget.',
        // The button of the player's own More Like This.
        confirm: 'Start New Session',
        confirming: 'Starting Session…',
        confirmed: 'Session started',
        failed: 'This session did not start',
      };
    }
    case 'newMusicOn': {
      const minutes = card.targetDurationMinutes;
      const choice = NEW_MUSIC_CHOICES[minutes === null ? 'no-limit' : 'target'];
      return {
        title: 'Switch New Music On',
        details: `${sessionTitle(card.session)} · ${
          minutes === null ? choice.label : `Up to ${minutes} min`
        }`,
        cost: choice.detail,
        confirm: newMusicSaveLabel(minutes),
        confirming: NEW_MUSIC_SAVING,
        confirmed: 'New Music is on',
        failed: 'New Music was not switched on',
      };
    }
    case 'surprise': {
      const { suggestion } = card;
      const minutes = card.targetDurationMinutes;
      return {
        title: 'Surprise Me',
        name: suggestion.title,
        details: [
          surpriseExploreLabel(suggestion),
          surpriseVibeLine(suggestion),
          surpriseVocalLine(suggestion),
          minutes === null ? NEW_MUSIC_CHOICES['no-limit'].label : `${minutes} min`,
        ].join(' · '),
        cost: 'Starting generates new tracks from your budget.',
        // The button of Home's Surprise Me.
        confirm: 'Start Session',
        confirming: 'Starting…',
        confirmed: 'Session started',
        failed: 'This session did not start',
      };
    }
    case 'cover': {
      const { subject } = card;
      return {
        title: 'New Cover',
        ...(card.guidance === undefined ? {} : { words: card.guidance }),
        details:
          subject.kind === 'session'
            ? `For the session ${sessionTitle(subject)}`
            : `For the playlist ${playlistName(subject)}`,
        // The cover dialog's rule: a new cover is previewed, never applied on its own.
        cost: 'Generating uses one cover from your budget. It becomes the cover only when you pick it.',
        confirm: 'Generate Cover',
        confirming: 'Generating…',
        confirmed: 'Generating the new cover. It will be under Previous Covers.',
        failed: 'No cover was generated',
      };
    }
  }
}
