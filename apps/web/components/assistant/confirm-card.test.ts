// Confirming a card hands its values to the app's flow, and the conversation
// keeps what that flow came to with the card: for a cover card, the attempt
// the regenerate route answered with, whether it started it or found it running.

import { describe, expect, it, vi } from 'vitest';
import type { AssistantCard } from '@liedmotif/shared';
import type { ProposedChatAction } from './card';
import { confirmCard, type CardConfirmation } from './confirm-card';
import type { ConversationMessage } from './conversation';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000009';

const RAINY: AssistantCard = {
  kind: 'cover',
  subject: { kind: 'session', id: '00000000-0000-4000-8000-000000000001', name: 'Rainy Window' },
};

/** A conversation holding one answer with `action` in it, settled as the panel's own is. */
function conversationWith(action: ProposedChatAction) {
  let messages: ConversationMessage[] = [{ role: 'assistant', content: '', actions: [action] }];
  const conversation: CardConfirmation['conversation'] = {
    getState: () => ({ messages, answering: false, draft: '', notice: null }),
    settleAction(held, outcome, facts) {
      if (!messages[0]!.actions!.includes(held)) return null;
      const settled = { ...held, outcome, ...facts };
      messages = [{ ...messages[0]!, actions: [settled] }];
      return settled;
    },
  };
  return { conversation, held: () => messages[0]!.actions![0] as ProposedChatAction };
}

describe('confirming a cover card', () => {
  it('keeps the attempt the regenerate route answered with', async () => {
    const offered: ProposedChatAction = { status: 'proposed', card: RAINY };
    const { conversation, held } = conversationWith(offered);
    const generateCover = vi.fn(async () => ({ carriedOut: true, coverGenerationId: ATTEMPT_ID }));

    confirmCard(offered, {
      conversation,
      host: { generateCover } as unknown as CardConfirmation['host'],
      onPlayerShown: () => {},
    });

    expect(generateCover).toHaveBeenCalledExactlyOnceWith({
      kind: 'session',
      request: { activitySessionId: RAINY.subject.id },
    });
    expect(held()).toMatchObject({ outcome: 'confirming' });
    await vi.waitFor(() =>
      expect(held()).toEqual({ ...offered, outcome: 'confirmed', coverGenerationId: ATTEMPT_ID }),
    );
  });
});
