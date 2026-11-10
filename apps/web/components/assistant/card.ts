// A card in words: what the chat shows for something the Assistant prepared
// and the user may confirm. It is written here from the structured values the
// confirmation sends; the model's own text is never part of it.

import type { AssistantAction, AssistantCard } from '@liedmotif/shared';
import type { CardOutcome } from '@/lib/assistant/card-note';

/** A card as the chat holds it. Without an outcome it is offered and waits for the user. */
export type ProposedChatAction = Extract<AssistantAction, { status: 'proposed' }> & {
  outcome?: CardOutcome;
};

export interface CardWording {
  /** What confirming does. */
  title: string;
  /** The words the request carries, shown as a quote. */
  words: string;
  /** The picks the request carries, in the app's own labels. */
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
    case 'session':
      return {
        title: 'Start a new Session',
        words: card.prompt,
        details: [
          card.vocal === 'vocal' ? 'With vocals' : 'Instrumental',
          ...(card.targetDurationMinutes === undefined
            ? []
            : [`${card.targetDurationMinutes} min`]),
        ].join(' · '),
        cost: 'Starting generates new Tracks from your budget.',
        confirm: 'Start Session',
        confirming: 'Starting…',
        confirmed: 'Session started',
        failed: 'This Session did not start',
      };
  }
}
