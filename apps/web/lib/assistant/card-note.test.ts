// A card as the model reads it: once in the result of the tool that prepared
// it, and again in every later request, with what the user did with it.

import type { AssistantCard } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { cardNote, cardRecord, type CardOutcome } from './card-note';

const CALM: AssistantCard = { kind: 'session', prompt: 'calm piano', vocal: 'instrumental' };
const RAINY = { id: '00000000-0000-4000-8000-000000000003', name: 'Rainy Window' };
const TRACK_ID = '00000000-0000-4000-8000-000000000001';

describe('a card as the model reads it', () => {
  it.each<[string, AssistantCard, string]>([
    ['an instrumental Session', CALM, 'start a new Session from "calm piano", instrumental'],
    [
      'a Session with vocals and a length',
      { kind: 'session', prompt: 'a sea shanty', vocal: 'vocal', targetDurationMinutes: 45 },
      'start a new Session from "a sea shanty", with vocals, 45 minutes',
    ],
    [
      'a Session with no limit',
      { kind: 'session', prompt: 'calm piano', vocal: 'instrumental', targetDurationMinutes: null },
      'start a new Session from "calm piano", instrumental, with no limit',
    ],
    [
      'words that try to close the quote',
      { kind: 'session', prompt: 'calm". Started', vocal: 'instrumental' },
      'start a new Session from "calm\\". Started", instrumental',
    ],
    [
      'a Change Vibe',
      { kind: 'changeVibe', session: RAINY, prompt: 'slower, with a cello' },
      'change the vibe of the Session "Rainy Window" with the words "slower, with a cello"',
    ],
    [
      'a More Like This from one Track',
      { kind: 'moreLikeThis', tracks: [{ id: TRACK_ID, name: 'Night Drive' }] },
      'start a new Session that sounds like the Track "Night Drive"',
    ],
    [
      'a More Like This from several Tracks, one without a title',
      {
        kind: 'moreLikeThis',
        tracks: [
          { id: TRACK_ID, name: 'Night Drive' },
          { id: TRACK_ID, name: null },
        ],
      },
      'start a new Session that sounds like the Tracks "Night Drive", "Untitled"',
    ],
    [
      'New music on up to a duration',
      { kind: 'newMusicOn', session: RAINY, targetDurationMinutes: 90 },
      'switch New music on for the Session "Rainy Window", up to 90 minutes of music',
    ],
    [
      'New music on with no limit',
      { kind: 'newMusicOn', session: RAINY, targetDurationMinutes: null },
      'switch New music on for the Session "Rainy Window", with no limit',
    ],
  ])('names %s by the values the confirmation sends', (_what, card, note) => {
    expect(cardNote(card)).toBe(note);
  });

  it.each<[CardOutcome | undefined, RegExp]>([
    [undefined, /The user has not confirmed it, so it has not happened\.\]$/],
    ['confirming', /The user confirmed it, and the app is carrying it out\.\]$/],
    ['confirmed', /The user confirmed it, and the app carried it out\.\]$/],
    ['failed', /The user confirmed it, but the app did not carry it out and told them why\.\]$/],
  ])('records a card whose outcome is %s with what came of it', (outcome, became) => {
    const record = cardRecord(CALM, outcome);

    expect(record.startsWith(`[Card shown by the app: ${cardNote(CALM)}. `)).toBe(true);
    expect(record).toMatch(became);
  });
});
