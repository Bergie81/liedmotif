// How a viewer is told WHO something belongs to. One vocabulary for
// every cross-owner surface — a Lounge entry, a Pin, a Shared reference — so
// the same owner can never be attributed differently depending on where they
// are met.

import { asc, sql, type SQL } from 'drizzle-orm';
import { listenerProfiles, user } from '../schema';

/** The attribution facts about an owner: their User name, the profile Artist
 *  Name when one is set (display prefers it), and their avatar URL. */
export interface OwnerAttribution {
  name: string;
  artistName: string | null;
  imageUrl: string | null;
}

/**
 * The `OwnerAttribution` selection. The query must join `user` and left-join
 * `listener_profiles` on the owner whose attribution it wants — the columns
 * carry no correlation of their own.
 */
export function ownerAttributionColumns() {
  return {
    name: user.name,
    artistName: listenerProfiles.artistName,
    imageUrl: user.image,
  } as const;
}

/**
 * Display-name order over the same joins as `ownerAttributionColumns` — the
 * name an owner is shown by, case-folded — with the user id as the tiebreak so
 * equal names keep one stable order.
 */
export function ownerDisplayNameOrder(): SQL[] {
  return [sql`lower(coalesce(${listenerProfiles.artistName}, ${user.name})) asc`, asc(user.id)];
}
