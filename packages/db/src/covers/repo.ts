// Access to cover rows by id. Pure Drizzle (no filesystem), so it is safe in the
// web/worker runtime bundle — unlike the ingest module, which reads bundled
// assets and lives behind the `@liedmotif/db/seed` subpath.

import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { coverImages } from '../schema';

export type CoverImageRow = typeof coverImages.$inferSelect;

/** A single cover image by id, or `null` when it does not exist. */
export async function getCoverImageById(db: Database, id: string): Promise<CoverImageRow | null> {
  const [row] = await db.select().from(coverImages).where(eq(coverImages.id, id)).limit(1);
  return row ?? null;
}

/**
 * Record how much storage a cover's cached tile rendition occupies. Renditions
 * are derived objects no other table knows about, so the storage quota can only
 * count them if the writer says so; the figure is restated rather than added to,
 * which keeps a re-render after an eviction exact.
 */
export async function recordCoverRenditionBytes(
  db: Database,
  args: { coverImageId: string; byteSize: number },
): Promise<void> {
  await db
    .update(coverImages)
    .set({ renditionByteSize: args.byteSize })
    .where(eq(coverImages.id, args.coverImageId));
}
