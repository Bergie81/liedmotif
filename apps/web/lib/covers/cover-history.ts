// Server-side projection of a cover subject's re-selectable history — settled
// generated attempts and owner uploads — into the modal's wire shape. Session
// and Playlist surfaces share it so their history reads identically.

import type { SessionCoverGenerationRow, UploadedCover } from '@liedmotif/db';
import type { SessionCoverHistoryEntry } from '@liedmotif/shared';

/** The style token an uploaded cover carries — it has no generated style lane. */
const UPLOADED_COVER_STYLE = 'uploaded';

/** Both halves in one list, newest first, each marked against the current cover. */
export function toCoverHistory(input: {
  generated: SessionCoverGenerationRow[];
  uploaded: UploadedCover[];
  currentCoverImageId: string | null;
}): SessionCoverHistoryEntry[] {
  return [
    ...input.generated.map((entry) => ({
      coverImageId: entry.coverImageId,
      style: entry.plan.resolvedStyle,
      createdAt: entry.createdAt,
    })),
    ...input.uploaded.map((upload) => ({
      coverImageId: upload.coverImageId,
      style: UPLOADED_COVER_STYLE,
      createdAt: upload.createdAt,
    })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      isCurrent: entry.coverImageId === input.currentCoverImageId,
    }));
}
