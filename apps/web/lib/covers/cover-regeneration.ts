// Server-side projection of Session Cover regeneration ledger rows into the
// modal's wire shape (`SessionCoverAttempt`). Failure copy is composed here
// from the ledger's sanitized state/category tokens only — never from private
// plan content.

import {
  SESSION_COVER_LIVE_STATES,
  type Database,
  type SessionCoverGenerationRow,
} from '@liedmotif/db';
import type { SessionCoverAttempt } from '@liedmotif/shared';
import { coverSetupMessage, type CoverSetupGap } from '@/lib/covers/cover-setup-copy';
import { cachedUserProfile } from '@/lib/request-cache';

const LIVE_STATES: ReadonlySet<SessionCoverGenerationRow['state']> = new Set(
  SESSION_COVER_LIVE_STATES,
);

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  not_admitted: 'The cover generation limit is reached. It resets with the usage window.',
  references_unsupported:
    'No usable reference photo for this cover — check the photos under Settings → People and whether your image model accepts reference images.',
  invalid_session_name: 'The name could not be used to plan a cover.',
  unsupported_capability: 'This cover request is too long for the selected image model.',
  provider_rejected: 'The image provider rejected this cover request.',
  provider_unavailable: 'The image provider is unavailable right now. Try again later.',
  submission_unknown:
    'The provider did not confirm the result. The attempt was counted; you can try again.',
  quality_rejected: 'The generated image did not pass the quality check.',
  storage_rejected: 'The generated cover could not be stored.',
  privacy_rejected: 'Photo privacy settings changed while the cover was generating.',
};

export type CoverViewerRole = 'admin' | 'member';

/** Only the Admin can fix the image account, so a Member is told who can, never the page. */
const ACCOUNT_NOT_READY_MESSAGES: Readonly<Record<CoverViewerRole, string>> = {
  admin: "Your image provider's account isn't ready for images. Check Settings › AI Providers.",
  member:
    "The image provider's account on this server isn't ready for images. Ask the Admin to check it.",
};

/** A profile-less owner is the instance owner, so only a Member row reads as `member`. */
export async function coverViewerRole(db: Database, ownerUserId: string): Promise<CoverViewerRole> {
  return (await cachedUserProfile(db, ownerUserId))?.role === 'member' ? 'member' : 'admin';
}

function isCoverSetupGap(category: string | null): category is CoverSetupGap {
  return category === 'generation_disabled' || category === 'provider_unconfigured';
}

/** Plain-language, safe copy for a settled failed attempt. */
export function coverFailureMessage(row: SessionCoverGenerationRow, role: CoverViewerRole): string {
  const setupGap = [row.failureCategory, row.state].find(isCoverSetupGap);
  if (setupGap) return coverSetupMessage(setupGap, role);
  if (row.failureCategory === 'account_not_ready') return ACCOUNT_NOT_READY_MESSAGES[role];
  return (
    FAILURE_MESSAGES[row.failureCategory ?? ''] ??
    FAILURE_MESSAGES[row.state] ??
    'Cover generation failed. The current cover is unchanged.'
  );
}

export function isLiveCoverGeneration(row: SessionCoverGenerationRow): boolean {
  return LIVE_STATES.has(row.state);
}

/** Project a user-regeneration ledger row into the modal's attempt shape. */
export function toSessionCoverAttempt(
  row: SessionCoverGenerationRow,
  role: CoverViewerRole,
): SessionCoverAttempt {
  const base = { coverGenerationId: row.id, coverImageId: row.coverImageId };
  if (isLiveCoverGeneration(row)) {
    return { ...base, status: 'generating', failureMessageSafe: null };
  }
  if (row.state === 'ready') {
    return { ...base, status: 'ready', failureMessageSafe: null };
  }
  return { ...base, status: 'failed', failureMessageSafe: coverFailureMessage(row, role) };
}
