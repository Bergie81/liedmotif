// A card as the chat shows it: worded here, from the values the confirmation
// sends, and from nothing the model wrote.

import type { AssistantCard } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { cardWording } from './card';

describe('a Session card', () => {
  const calm: AssistantCard = { kind: 'session', prompt: 'calm piano', vocal: 'instrumental' };

  it('says what confirming starts, in the user’s words, and what the button does', () => {
    expect(cardWording(calm)).toMatchObject({
      title: 'Start a new Session',
      words: 'calm piano',
      details: 'Instrumental',
      cost: 'Starting generates new Tracks from your budget.',
      confirm: 'Start Session',
      confirming: 'Starting…',
      confirmed: 'Session started',
      failed: 'This Session did not start',
    });
  });

  it('names vocals and the length when the card carries them', () => {
    expect(cardWording({ ...calm, vocal: 'vocal', targetDurationMinutes: 45 }).details).toBe(
      'With vocals · 45 min',
    );
  });
});
