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

  it('says No limit, in the player’s words, when the Session generates without a target', () => {
    expect(cardWording({ ...calm, targetDurationMinutes: null }).details).toBe(
      'Instrumental · No limit',
    );
  });
});

const RAINY = { id: '00000000-0000-4000-8000-000000000003', name: 'Rainy Window' };
const track = (name: string | null) => ({ id: '00000000-0000-4000-8000-000000000001', name });

describe('a Change Vibe card', () => {
  it('says whose vibe changes, in the user’s words, and what the button does', () => {
    expect(
      cardWording({ kind: 'changeVibe', session: RAINY, prompt: 'slower, with a cello' }),
    ).toEqual({
      title: 'Change Vibe',
      words: 'slower, with a cello',
      details: 'In Rainy Window',
      cost: 'Changing the vibe generates new Tracks from your budget.',
      confirm: 'Change Vibe',
      confirming: 'Changing…',
      confirmed: 'Vibe changed',
      failed: 'The vibe did not change',
    });
  });

  it('names a Session without a title as the app does', () => {
    expect(
      cardWording({ kind: 'changeVibe', session: { ...RAINY, name: null }, prompt: 'slower' })
        .details,
    ).toBe('In Untitled Session');
  });
});

describe('a More Like This card', () => {
  it('names the seed Track and the button of the player’s own More Like This', () => {
    expect(cardWording({ kind: 'moreLikeThis', tracks: [track('Night Drive')] })).toEqual({
      title: 'More Like This',
      details: 'A new Session seeded from Night Drive',
      cost: 'Starting generates new Tracks from your budget.',
      confirm: 'Start new Session',
      confirming: 'Starting Session…',
      confirmed: 'Session started',
      failed: 'This Session did not start',
    });
  });

  it('counts and lists several seed Tracks', () => {
    expect(
      cardWording({
        kind: 'moreLikeThis',
        tracks: [track('Night Drive'), track(null), track('Low Tide')],
      }).details,
    ).toBe('A new Session seeded from 3 Tracks: Night Drive, Untitled Track, Low Tide');
  });
});

describe('a New music card', () => {
  it('words a duration as the player’s New music control does, Save button included', () => {
    expect(cardWording({ kind: 'newMusicOn', session: RAINY, targetDurationMinutes: 90 })).toEqual({
      title: 'Switch New music on',
      details: 'Rainy Window · Up to 90 min',
      cost: 'Buys music until the target.',
      confirm: 'Save · up to 90 min',
      confirming: 'Saving…',
      confirmed: 'New music is on',
      failed: 'New music was not switched on',
    });
  });

  it('words No limit as that control does', () => {
    expect(
      cardWording({ kind: 'newMusicOn', session: RAINY, targetDurationMinutes: null }),
    ).toMatchObject({
      details: 'Rainy Window · No limit',
      cost: 'Keeps buying while you listen.',
      confirm: 'Save · no limit',
    });
  });
});
