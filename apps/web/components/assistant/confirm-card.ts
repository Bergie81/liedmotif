// Confirming a card: the one way from the chat to anything that can spend.
// The card's button calls `confirmCard`, and so would any other way of saying
// yes to the card on screen; it hands the card's values to the flow the app's
// own button runs. A card is confirmed at most once: the conversation holds
// what became of it, and only a card it holds without an outcome goes through.

import { sessionCardStartRequest, type AssistantCard } from '@liedmotif/shared';
import type { ProposedChatAction } from './card';
import type { AssistantConversation } from './conversation';
import type { CardFlowResult, CardHost } from './use-card-host';

export interface CardConfirmation {
  /** The conversation the card is part of. */
  conversation: Pick<AssistantConversation, 'getState' | 'settleAction'>;
  host: Pick<CardHost, 'startSession' | 'changeVibe' | 'moreLikeThis' | 'newMusicOn'>;
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
    case 'changeVibe':
      return host.changeVibe(card.session.id, { mode: 'prompt', prompt: card.prompt });
    case 'moreLikeThis': {
      const started = host.moreLikeThis(card.tracks.map(({ id }) => id));
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
  }
}

export function confirmCard(action: ProposedChatAction, confirmation: CardConfirmation): void {
  const { conversation } = confirmation;
  // Everything up to the settling runs inside the one click, so a second click
  // finds either an outcome or a card the conversation no longer holds.
  const offered =
    !action.outcome &&
    conversation.getState().messages.some((message) => message.actions?.includes(action));
  if (!offered) return;
  const sent = run(action.card, confirmation);
  if (!sent) return;
  const confirming = conversation.settleAction(action, 'confirming');
  void sent.then(({ carriedOut, refusal }) => {
    if (!confirming) return;
    if (carriedOut) conversation.settleAction(confirming, 'confirmed');
    else conversation.settleAction(confirming, 'failed', refusal);
  });
}
