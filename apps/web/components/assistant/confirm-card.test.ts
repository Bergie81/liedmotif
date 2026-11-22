// Confirming a card hands its values to the app's flow, and the conversation
// keeps what that flow came to with the card: for a cover card, the attempt
// the regenerate route answered with, whether it started it or found it running;
// for a new Session card, the length the user set on it.

import { describe, expect, it, vi } from 'vitest';
import type { AssistantCard } from '@liedmotif/shared';
import type { ProposedChatAction } from './card';
import { withActionNotes } from './chat-actions';
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

describe('confirming a new Session card', () => {
  const CALM: AssistantCard = {
    kind: 'session',
    prompt: 'calm piano',
    vocal: 'instrumental',
    targetDurationMinutes: 30,
  };
  const SEEDED: AssistantCard = {
    kind: 'moreLikeThis',
    tracks: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Night Drive' }],
    targetDurationMinutes: 30,
  };
  const HARBOR: AssistantCard = {
    kind: 'surprise',
    suggestion: {
      id: '00000000-0000-4000-8000-000000000004',
      adventurous: false,
      title: 'Harbor Morning',
      mood: 'hazy',
      genres: ['jazz'],
      energy: 'low',
      vocalMode: 'instrumental',
      voiceGender: null,
      language: null,
    },
    targetDurationMinutes: 30,
  };
  const started = async () => ({ carriedOut: true });

  function confirmWith(card: AssistantCard, length?: number | null) {
    const offered: ProposedChatAction = { status: 'proposed', card };
    const { conversation, held } = conversationWith(offered);
    const host = {
      startSession: vi.fn(started),
      moreLikeThis: vi.fn(started),
      startSurprise: vi.fn(started),
    };
    confirmCard(
      offered,
      { conversation, host: host as unknown as CardConfirmation['host'], onPlayerShown: () => {} },
      length,
    );
    return { host, held };
  }

  it('sends the length the user set on the card, and keeps it with the card Roadie reads', async () => {
    const { host, held } = confirmWith(CALM, 60);

    expect(host.startSession).toHaveBeenCalledExactlyOnceWith({
      input: { mode: 'prompt', prompt: 'calm piano', vocal: 'instrumental' },
      targetDurationMinutes: 60,
    });
    expect(held().card).toEqual({ ...CALM, targetDurationMinutes: 60 });
    await vi.waitFor(() => expect(held()).toMatchObject({ outcome: 'confirmed' }));
    expect(held().card).toEqual({ ...CALM, targetDurationMinutes: 60 });
    const note = withActionNotes('', [held()]);
    expect(note).toMatch(/60 minutes/);
    expect(note).not.toMatch(/30 minutes/);
  });

  it('sends No limit as an explicit null, and the card then says no limit', async () => {
    const { host, held } = confirmWith(SEEDED, null);

    expect(host.moreLikeThis).toHaveBeenCalledExactlyOnceWith({
      seedTrackIds: ['00000000-0000-4000-8000-000000000002'],
      targetDurationMinutes: null,
    });
    await vi.waitFor(() => expect(held()).toMatchObject({ outcome: 'confirmed' }));
    expect(held().card).toMatchObject({ targetDurationMinutes: null });
    expect(withActionNotes('', [held()])).toMatch(/with no limit/);
  });

  it('sends the length the card started with when the user left the slider alone', () => {
    const { host, held } = confirmWith(HARBOR);

    expect(host.startSurprise).toHaveBeenCalledExactlyOnceWith({
      proposalId: '00000000-0000-4000-8000-000000000004',
      targetDurationMinutes: 30,
    });
    expect(held().card).toEqual(HARBOR);
  });
});
