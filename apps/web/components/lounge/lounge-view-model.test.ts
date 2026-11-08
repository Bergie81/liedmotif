import { describe, expect, it } from 'vitest';
import { buildSharerCards, loungeOwnerDisplayName } from './lounge-view-model';

// The Lounge attribution rule: the profile's
// Artist Name when set, else the owner's FIRST name — the same fallback family
// as the MP3 artist tag, but first-name-short because a tile meta line has one
// breath of room.

describe('loungeOwnerDisplayName', () => {
  it('prefers the artist name and falls back to the first name, not the full name', () => {
    expect(loungeOwnerDisplayName('Nightowl', 'Anna Schmidt')).toBe('Nightowl');
    expect(loungeOwnerDisplayName(null, 'Anna Schmidt')).toBe('Anna');
  });

  it('a whitespace-only artist name must not attribute a share to a blank line', () => {
    expect(loungeOwnerDisplayName('   ', 'Jonas Weber')).toBe('Jonas');
    expect(loungeOwnerDisplayName(null, '   ')).toBe('');
  });
});

// The sharer cards: only currently-sharing members, the viewer's
// own card labeled "You" and hoisted first even though the sharers arrive
// display-name ordered from the repo.

describe('buildSharerCards', () => {
  const sharers = [
    {
      userId: 'u-anna',
      name: 'Anna Schmidt',
      artistName: 'Nightowl',
      imageUrl: null,
      description: 'Rainy windows, late trains',
      sharedTrackCount: 12,
    },
    {
      userId: 'u-john',
      name: 'John Doe',
      artistName: null,
      imageUrl: '/api/avatar/x',
      description: null,
      sharedTrackCount: 1,
    },
  ];

  it('hoists the sharing viewer to the front, labeled You', () => {
    expect(buildSharerCards(sharers, 'u-john')).toEqual([
      {
        userId: 'u-john',
        label: 'You',
        imageUrl: '/api/avatar/x',
        avatarName: 'John',
        description: null,
        sharedTrackCount: 1,
      },
      {
        userId: 'u-anna',
        label: 'Nightowl',
        imageUrl: null,
        avatarName: 'Nightowl',
        description: 'Rainy windows, late trains',
        sharedTrackCount: 12,
      },
    ]);
  });

  it('a viewer who shares nothing gets no dead card', () => {
    expect(buildSharerCards(sharers, 'u-jonas').map((card) => card.label)).toEqual([
      'Nightowl',
      'John',
    ]);
  });
});
