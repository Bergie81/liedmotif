// The built-in placeholder Session Cover — the branded Liedmotif art a fresh
// session wears while its generated cover is still being bought. It is a normal
// `cover_images` row (sourceType `placeholder`) with bundled bytes ingested into
// storage, so it is served through the same admin-gated `/api/covers/<id>` route
// as every other cover (never a public static path).

import { PLACEHOLDER_COVER_ID } from '@liedmotif/shared';
import type { Database } from '../client';
import { coverImages } from '../schema';

export { PLACEHOLDER_COVER_ID };

/** Canonical storage key of the placeholder-cover bytes. */
export const PLACEHOLDER_COVER_STORAGE_KEY = 'covers/placeholder.webp';

/** Display label stored in the row's `tags` blob (pinned by the migration too). */
export const PLACEHOLDER_COVER_LABEL = 'Liedmotif';

/** Seed the placeholder cover row (idempotent; conflict target is the stable id). */
export async function seedPlaceholderCover(db: Database): Promise<void> {
  await db
    .insert(coverImages)
    .values({
      id: PLACEHOLDER_COVER_ID,
      sourceType: 'placeholder',
      storageProvider: 'local',
      storageKey: PLACEHOLDER_COVER_STORAGE_KEY,
      tags: { label: PLACEHOLDER_COVER_LABEL },
      // Brand art by design: the embed path must never stack a badge on it.
      branded: true,
    })
    .onConflictDoNothing({ target: coverImages.id });
}
