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
import type { CardOutcome } from '@/lib/assistant/card-note';
import { sessionTitle, trackTitle } from './receipt';

/** A card as the chat holds it. Without an outcome it is offered and waits for the user. */
export type ProposedChatAction = Extract<AssistantAction, { status: 'proposed' }> & {
  outcome?: CardOutcome;
  /** Why the app did not carry it out, in the app's words, when the card is where that shows. */
  refusal?: string;
};

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

export function cardWording(card: AssistantCard): CardWording {
  switch (card.kind) {
    case 'session': {
      const minutes = card.targetDurationMinutes;
      const details = [card.vocal === 'vocal' ? 'With vocals' : 'Instrumental'];
      if (minutes === null) details.push(NEW_MUSIC_CHOICES['no-limit'].label);
      else if (minutes !== undefined) details.push(`${minutes} min`);
      return {
        title: 'Start a new Session',
        words: card.prompt,
        details: details.join(' · '),
        cost: 'Starting generates new Tracks from your budget.',
        confirm: 'Start Session',
        confirming: 'Starting…',
        confirmed: 'Session started',
        failed: 'This Session did not start',
      };
    }
    case 'changeVibe':
      return {
        title: 'Change Vibe',
        words: card.prompt,
        details: `In ${sessionTitle(card.session)}`,
        cost: 'Changing the vibe generates new Tracks from your budget.',
        confirm: 'Change Vibe',
        confirming: 'Changing…',
        confirmed: 'Vibe changed',
        failed: 'The vibe did not change',
      };
    case 'moreLikeThis': {
      const titles = card.tracks.map(trackTitle).join(', ');
      return {
        title: 'More Like This',
        details: `A new Session seeded from ${
          card.tracks.length === 1 ? titles : `${card.tracks.length} Tracks: ${titles}`
        }`,
        cost: 'Starting generates new Tracks from your budget.',
        // The button of the player's own More Like This.
        confirm: 'Start new Session',
        confirming: 'Starting Session…',
        confirmed: 'Session started',
        failed: 'This Session did not start',
      };
    }
    case 'newMusicOn': {
      const minutes = card.targetDurationMinutes;
      const choice = NEW_MUSIC_CHOICES[minutes === null ? 'no-limit' : 'target'];
      return {
        title: 'Switch New music on',
        details: `${sessionTitle(card.session)} · ${
          minutes === null ? choice.label : `Up to ${minutes} min`
        }`,
        cost: choice.detail,
        confirm: newMusicSaveLabel(minutes),
        confirming: NEW_MUSIC_SAVING,
        confirmed: 'New music is on',
        failed: 'New music was not switched on',
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
        cost: 'Starting generates new Tracks from your budget.',
        // The button of Home's Surprise Me.
        confirm: 'Start Session',
        confirming: 'Starting…',
        confirmed: 'Session started',
        failed: 'This Session did not start',
      };
    }
  }
}
