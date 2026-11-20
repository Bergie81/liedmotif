// The one read-only gate in front of a paid cover attempt, for a Session or a
// Playlist: would a new attempt be refused, and with which of the app's own
// messages? Both regenerate routes fast-fail on it before they spend anything
// (the paid cover-text enhancement runs before the admission lock), and the
// Assistant asks it before offering a cover card, so the two cannot disagree.
//
// It reads and never writes, and calls no provider. It is advisory and racy by
// design: each route's admission under the owner cover lock re-checks and stays
// the authority.

import { NextResponse } from 'next/server';
import {
  advisoryCoverAdmission,
  countPlaylistCoverHistory,
  countSessionCoverHistory,
  getLivePlaylistCoverGeneration,
  getLiveSessionCoverGeneration,
  getUsageLimits,
  type Database,
  type UsageLimits,
} from '@liedmotif/db';
import { MAX_PLAYLIST_COVER_HISTORY, MAX_SESSION_COVER_HISTORY } from '@liedmotif/shared';
import { apiError } from '@/lib/http/api-response';
import { COVER_LIMIT_REACHED_MESSAGE } from '@/lib/covers/cover-budget';
import { coverViewerRole } from '@/lib/covers/cover-regeneration';
import { coverSetupMessage, type CoverSetupGap } from '@/lib/covers/cover-setup-copy';
import { ACCOUNT_DISABLED_MESSAGE } from '@/lib/constants';
import { generatedCoverProviderConfigured } from '@/lib/covers/covers';

export const SESSION_COVERS_FULL_MESSAGE = `This session already keeps ${MAX_SESSION_COVER_HISTORY} covers. Delete a previous cover to generate a new one.`;
export const PLAYLIST_COVERS_FULL_MESSAGE = `This playlist already keeps ${MAX_PLAYLIST_COVER_HISTORY} covers. Delete a previous cover to generate a new one.`;

/** The owner's Session or Playlist a cover attempt is for. Ownership and
 *  existence are the caller's to check: the gate only reads its cover state. */
export type CoverSubject = { kind: 'session'; id: string } | { kind: 'playlist'; id: string };

export type CoverGateRefusalReason =
  CoverSetupGap | 'history_full' | 'account_disabled' | 'limit_reached';

export type CoverGateRefusal = {
  outcome: 'refused';
  reason: CoverGateRefusalReason;
  message: string;
};

export type CoverAttemptGate =
  /** Nothing would refuse; the instance limits read on the way, for the admission. */
  | { outcome: 'open'; instanceLimits: UsageLimits }
  /** An attempt is already live; a request answers with it instead of spending. */
  | { outcome: 'pending'; coverGenerationId: string }
  | CoverGateRefusal;

async function setupRefusal(
  db: Database,
  ownerUserId: string,
  gap: CoverSetupGap,
): Promise<CoverGateRefusal> {
  return {
    outcome: 'refused',
    reason: gap,
    message: coverSetupMessage(gap, await coverViewerRole(db, ownerUserId)),
  };
}

async function liveAttemptId(
  db: Database,
  ownerUserId: string,
  subject: CoverSubject,
): Promise<string | null> {
  const live =
    subject.kind === 'session'
      ? await getLiveSessionCoverGeneration(db, { ownerUserId, activitySessionId: subject.id })
      : await getLivePlaylistCoverGeneration(db, { ownerUserId, playlistId: subject.id });
  return live?.id ?? null;
}

async function historyFullMessage(
  db: Database,
  ownerUserId: string,
  subject: CoverSubject,
): Promise<string | null> {
  if (subject.kind === 'session') {
    const kept = await countSessionCoverHistory(db, { ownerUserId, activitySessionId: subject.id });
    return kept >= MAX_SESSION_COVER_HISTORY ? SESSION_COVERS_FULL_MESSAGE : null;
  }
  const kept = await countPlaylistCoverHistory(db, { ownerUserId, playlistId: subject.id });
  return kept >= MAX_PLAYLIST_COVER_HISTORY ? PLAYLIST_COVERS_FULL_MESSAGE : null;
}

/** Whether a new cover attempt for `subject` would be refused, already runs, or may go ahead. */
export async function coverAttemptGate(
  db: Database,
  args: { ownerUserId: string; subject: CoverSubject },
): Promise<CoverAttemptGate> {
  const { ownerUserId, subject } = args;
  if (!(await generatedCoverProviderConfigured())) {
    return setupRefusal(db, ownerUserId, 'provider_unconfigured');
  }
  const instanceLimits = await getUsageLimits(db);
  if (!instanceLimits.tailoredCoverArtEnabled) {
    return setupRefusal(db, ownerUserId, 'generation_disabled');
  }
  const liveId = await liveAttemptId(db, ownerUserId, subject);
  if (liveId) return { outcome: 'pending', coverGenerationId: liveId };
  const fullMessage = await historyFullMessage(db, ownerUserId, subject);
  if (fullMessage) return { outcome: 'refused', reason: 'history_full', message: fullMessage };
  const admission = await advisoryCoverAdmission(db, {
    ownerUserId,
    instanceLimits,
    now: new Date(),
  });
  if (!admission.admitted) {
    return admission.reason === 'account_disabled'
      ? { outcome: 'refused', reason: 'account_disabled', message: ACCOUNT_DISABLED_MESSAGE }
      : { outcome: 'refused', reason: 'limit_reached', message: COVER_LIMIT_REACHED_MESSAGE };
  }
  return { outcome: 'open', instanceLimits };
}

/** The regenerate routes' answer to a refusal. */
export function coverGateRefusalResponse(refusal: CoverGateRefusal): NextResponse {
  switch (refusal.reason) {
    case 'provider_unconfigured':
    case 'generation_disabled':
      return apiError('conflict', refusal.message);
    case 'history_full':
    case 'limit_reached':
      return apiError('limit_reached', refusal.message);
    case 'account_disabled':
      return apiError('unauthorized', refusal.message, { status: 403 });
  }
}
