// Confirming a card: the one way from the chat to anything that can spend.
// The card's button calls `confirmCard`, and so would any other way of saying
// yes to the card on screen; it hands the card's values to the flow the app's
// own button runs. A card is confirmed at most once: the conversation holds
// what became of it, and only a card it holds without an outcome goes through.
// The one value the user can change on a card is a new Session's length: the
// card the conversation holds takes it at the confirmation, so every later
// wording of the card and every note Roadie reads of it states what was sent.

import {
  coverCardRegenerateRequest,
  isNewSessionCard,
  moreLikeThisCardRequest,
  sessionCardStartRequest,
  surpriseCardStartRequest,
  type AssistantCard,
} from '@liedmotif/shared';
import type { ProposedChatAction } from './card';
import type { AssistantConversation } from './conversation';
import type { CardFlowResult, CardHost } from './use-card-host';

export interface CardConfirmation {
  /** The conversation the card is part of. */
  conversation: Pick<AssistantConversation, 'getState' | 'settleAction'>;
  host: Pick<
    CardHost,
    | 'startSession'
    | 'startSurprise'
    | 'changeVibe'
    | 'moreLikeThis'
    | 'newMusicOn'
    | 'generateCover'
  >;
  /** The card's flow went to the Player: a panel that covers the page gets out of its way. */
  onPlayerShown: () => void;
}

/**
 * Runs the app's flow for `card`. Resolves with what it came to; null when
 * nothing was sent and the card may be confirmed again.
 */
function run(
  card: AssistantCard,
  { host, onPlayerShown }: CardConfirmation,
): Promise<CardFlowResult> | null {
  switch (card.kind) {
    case 'session': {
      const started = host.startSession(sessionCardStartRequest(card));
      // The start flow goes to the Player whether or not this click sent the request.
      onPlayerShown();
      return started;
    }
    case 'surprise': {
      const started = host.startSurprise(surpriseCardStartRequest(card));
      // Home's Surprise Me start goes to the Player as the Session start does.
      onPlayerShown();
      return started;
    }
    case 'changeVibe':
      return host.changeVibe(card.session.id, { mode: 'prompt', prompt: card.prompt });
    case 'moreLikeThis': {
      const started = host.moreLikeThis(moreLikeThisCardRequest(card));
      // The seed flow goes to the Player once the new Session exists; a click
      // that sent nothing went there at once.
      if (!started) onPlayerShown();
      void started?.then(({ carriedOut }) => {
        if (carriedOut) onPlayerShown();
      });
      return started;
    }
    case 'newMusicOn':
      return host.newMusicOn(card.session.id, card.targetDurationMinutes);
    case 'cover':
      return host.generateCover(coverCardRegenerateRequest(card));
  }
}

/**
 * Confirms `action`'s card. `targetDurationMinutes` is the length the user set
 * on a new Session card, null for No limit; left out, the card's own is sent.
 * Any other card ignores it.
 */
export function confirmCard(
  action: ProposedChatAction,
  confirmation: CardConfirmation,
  targetDurationMinutes?: number | null,
): void {
  const { conversation } = confirmation;
  // Everything up to the settling runs inside the one click, so a second click
  // finds either an outcome or a card the conversation no longer holds.
  const offered =
    !action.outcome &&
    conversation.getState().messages.some((message) => message.actions?.includes(action));
  if (!offered) return;
  const card =
    targetDurationMinutes !== undefined && isNewSessionCard(action.card)
      ? { ...action.card, targetDurationMinutes }
      : action.card;
  const sent = run(card, confirmation);
  if (!sent) return;
  const confirming = conversation.settleAction(action, 'confirming', { card });
  void sent.then(({ carriedOut, refusal, coverGenerationId }) => {
    if (!confirming) return;
    if (carriedOut) {
      conversation.settleAction(confirming, 'confirmed', {
        ...(coverGenerationId !== undefined && { coverGenerationId }),
      });
    } else {
      conversation.settleAction(confirming, 'failed', {
        ...(refusal !== undefined && { refusal }),
      });
    }
  });
}
