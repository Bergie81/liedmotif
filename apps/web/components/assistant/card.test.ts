// A card as the chat shows it: worded here, from the values the confirmation
// sends, and from nothing the model wrote.

import type { AssistantCard } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { cardWording } from './card';

describe('a Session card', () => {
  const calm: AssistantCard = { kind: 'session', prompt: 'calm piano', vocal: 'instrumental' };

  it('says what confirming starts, in the user’s words, and what the button does', () => {
    expect(cardWording(calm)).toMatchObject({
      title: 'Start a New Session',
      words: 'calm piano',
      details: 'Instrumental',
      cost: 'Starting generates new tracks from your budget.',
      confirm: 'Start Session',
      confirming: 'Starting…',
      confirmed: 'Session started',
      failed: 'This session did not start',
    });
  });

  it('names vocals and the length when the card carries them', () => {
    expect(cardWording({ ...calm, vocal: 'vocal', targetDurationMinutes: 45 }).details).toBe(
      'With vocals · 45 min',
    );
  });

  it('says No limit, in the player’s words, when the Session generates without a target', () => {
    expect(cardWording({ ...calm, targetDurationMinutes: null }).details).toBe(
      'Instrumental · No Limit',
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
      cost: 'Changing the vibe generates new tracks from your budget.',
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
      details: 'A new session seeded from Night Drive',
      cost: 'Starting generates new tracks from your budget.',
      confirm: 'Start New Session',
      confirming: 'Starting Session…',
      confirmed: 'Session started',
      failed: 'This session did not start',
    });
  });

  it('counts and lists several seed Tracks', () => {
    expect(
      cardWording({
        kind: 'moreLikeThis',
        tracks: [track('Night Drive'), track(null), track('Low Tide')],
      }).details,
    ).toBe('A new session seeded from 3 tracks: Night Drive, Untitled Track, Low Tide');
  });

  it('adds the length the way the Session card does', () => {
    const seeded = (targetDurationMinutes: number | null) =>
      cardWording({ kind: 'moreLikeThis', tracks: [track('Night Drive')], targetDurationMinutes })
        .details;

    expect(seeded(60)).toBe('A new session seeded from Night Drive · 60 min');
    expect(seeded(null)).toBe('A new session seeded from Night Drive · No Limit');
  });
});

describe('a New Music card', () => {
  it('words a duration as the player’s New Music control does, Save button included', () => {
    expect(cardWording({ kind: 'newMusicOn', session: RAINY, targetDurationMinutes: 90 })).toEqual({
      title: 'Switch New Music On',
      details: 'Rainy Window · Up to 90 min',
      cost: 'Buys music until the target.',
      confirm: 'Save · Up to 90 min',
      confirming: 'Saving…',
      confirmed: 'New Music is on',
      failed: 'New Music was not switched on',
    });
  });

  it('words No limit as that control does', () => {
    expect(
      cardWording({ kind: 'newMusicOn', session: RAINY, targetDurationMinutes: null }),
    ).toMatchObject({
      details: 'Rainy Window · No Limit',
      cost: 'Keeps buying while you listen.',
      confirm: 'Save · No Limit',
    });
  });
});

describe('a Surprise Me card', () => {
  const harbor: Extract<AssistantCard, { kind: 'surprise' }> = {
    kind: 'surprise',
    suggestion: {
      id: '00000000-0000-4000-8000-000000000004',
      adventurous: false,
      title: 'Harbor Morning',
      mood: 'hazy',
      genres: ['lofi', 'jazz'],
      energy: 'low',
      vocalMode: 'instrumental',
      voiceGender: null,
      language: null,
    },
    targetDurationMinutes: 45,
  };

  it('shows the suggestion as Home’s Surprise Me previews it, with its length and Home’s Start button', () => {
    expect(cardWording(harbor)).toEqual({
      title: 'Surprise Me',
      name: 'Harbor Morning',
      details: 'Familiar · Lo-fi, Jazz · hazy · Low energy · Instrumental · 45 min',
      cost: 'Starting generates new tracks from your budget.',
      confirm: 'Start Session',
      confirming: 'Starting…',
      confirmed: 'Session started',
      failed: 'This session did not start',
    });
  });

  it('names an adventurous one, its singer, and No limit', () => {
    expect(
      cardWording({
        ...harbor,
        suggestion: {
          ...harbor.suggestion,
          adventurous: true,
          vocalMode: 'vocal',
          voiceGender: 'female',
          language: 'English',
        },
        targetDurationMinutes: null,
      }).details,
    ).toBe(
      'Adventurous · Lo-fi, Jazz · hazy · Low energy · Vocals · English · Female voice · No Limit',
    );
  });
});

describe('a cover card', () => {
  const rainy: AssistantCard = {
    kind: 'cover',
    subject: { kind: 'session', id: '00000000-0000-4000-8000-000000000001', name: 'Rainy Window' },
    guidance: 'darker, neon city',
  };

  it('says what the cover is for, quotes the art direction, and what confirming costs', () => {
    expect(cardWording(rainy)).toEqual({
      title: 'New Cover',
      words: 'darker, neon city',
      details: 'For the session Rainy Window',
      cost: 'Generating uses one cover from your budget. It becomes the cover only when you pick it.',
      confirm: 'Generate Cover',
      confirming: 'Generating…',
      confirmed: 'Generating the new cover. It will be under Previous Covers.',
      failed: 'No cover was generated',
    });
  });

  it('names a Playlist, and leaves out the quote without art direction', () => {
    const wording = cardWording({
      kind: 'cover',
      subject: { kind: 'playlist', id: '00000000-0000-4000-8000-000000000002', name: 'Running' },
    });

    expect(wording.details).toBe('For the playlist Running');
    expect(wording.words).toBeUndefined();
  });
});
