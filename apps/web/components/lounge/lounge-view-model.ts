// Presentation rules the Lounge tiles agree on. Card meta reuses
// the Playlists grid's own formatters; only what the Lounge adds lives here.

import type { LoungeSharerRow } from '@liedmotif/db';

/**
 * How a share is attributed: the owner's Artist Name when set, else their
 * first name — the MP3 artist-tag family of fallbacks, shortened to the first
 * name because a tile meta line has one breath of room.
 */
export function loungeOwnerDisplayName(ownerArtistName: string | null, ownerName: string): string {
  return ownerArtistName?.trim() || (ownerName.trim().split(/\s+/)[0] ?? '');
}

/** A currently-sharing owner, as the repo reports them (plain, serializable). */
export type LoungeSharer = LoungeSharerRow;

export interface SharerCard {
  userId: string;
  /** Card heading: "You" for the viewer, else the attribution display name. */
  label: string;
  /** The attribution name the avatar initial is cut from — never "You". */
  avatarName: string;
  imageUrl: string | null;
  description: string | null;
  sharedTrackCount: number;
}

/**
 * The sharer profile cards that double as the member filter: only Members who
 * currently share, the viewer hoisted first and labeled "You" (the repo's
 * display-name order holds for everyone else). A viewer who shares nothing
 * gets no dead card.
 */
export function buildSharerCards(sharers: LoungeSharer[], viewerUserId: string): SharerCard[] {
  const cards = sharers.map((sharer) => {
    const displayName = loungeOwnerDisplayName(sharer.artistName, sharer.name);
    return {
      userId: sharer.userId,
      label: sharer.userId === viewerUserId ? 'You' : displayName,
      avatarName: displayName,
      imageUrl: sharer.imageUrl,
      description: sharer.description,
      sharedTrackCount: sharer.sharedTrackCount,
    };
  });
  return [
    ...cards.filter((c) => c.userId === viewerUserId),
    ...cards.filter((c) => c.userId !== viewerUserId),
  ];
}

/** How many members seed a playlist-level More Like This — the seed route's
 *  request cap, and the same count the playlist player seeds with. */
export const LOUNGE_MLT_SEED_TRACKS = 10;
