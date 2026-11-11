// What the Better Auth `user` row may be written to, stated app-side.
//
// Better Auth's `updateUser` writes `name` and `image` through untouched — the
// profile route's length checks and the avatar route's upload pipeline never see
// it. The HTTP endpoint is refused at the auth catch-all; this is the same rule,
// expressed where Better Auth's database hook can reach it, so every write that
// still reaches the hook (the app's own server-side `updateUser` calls, or the
// endpoint should it ever be mounted again) is held to it.

import type { UserUpdateFields } from '@liedmotif/db/auth';
import { avatarIdFromUrl } from '@/lib/avatar';
import { MAX_PROFILE_FIELD_LENGTH } from '@/lib/constants';

/**
 * A user-facing refusal for a `user` row update, or `null` to allow it. Only
 * the fields actually present are judged: an absent key is not a write.
 */
export function refuseUserUpdate(update: UserUpdateFields): string | null {
  // The raw length is judged: Better Auth stores `name` untrimmed.
  if (update.name !== undefined) {
    if (typeof update.name !== 'string' || update.name.length > MAX_PROFILE_FIELD_LENGTH) {
      return `Name must be text of at most ${MAX_PROFILE_FIELD_LENGTH} characters.`;
    }
  }
  // `null` clears the avatar; anything else must be an URL this app minted, so
  // the row can never point the browser at a foreign host.
  if (update.image !== undefined && update.image !== null) {
    if (typeof update.image !== 'string' || !avatarIdFromUrl(update.image)) {
      return 'Profile image must be an avatar uploaded to this instance.';
    }
  }
  return null;
}
