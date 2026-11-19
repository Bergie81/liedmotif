// The profile avatar's opaque URL scheme, shared by the upload/serve routes and
// the client uploader. `user.image` stores an app-routed URL (never a storage
// key or filesystem path); the serving route rebuilds the storage key from the
// session owner's id, so ownership is enforced by construction. A fresh
// avatarId per upload makes every URL immutable-cacheable.

import { uuidSchema } from '@liedmotif/shared';

const AVATAR_URL_PREFIX = '/api/avatar/';

export function avatarUrlForId(avatarId: string): string {
  return `${AVATAR_URL_PREFIX}${avatarId}`;
}

/** The avatarId inside a stored `user.image` URL, or null for any other value. */
export function avatarIdFromUrl(imageUrl: string | null): string | null {
  if (!imageUrl?.startsWith(AVATAR_URL_PREFIX)) return null;
  const avatarId = imageUrl.slice(AVATAR_URL_PREFIX.length);
  return uuidSchema.safeParse(avatarId).success ? avatarId : null;
}

/** The fallback identity-chip letter when no avatar image is set. */
export function listenerInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || 'P';
}
