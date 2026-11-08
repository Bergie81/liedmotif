// The app-shell chrome slice — the caller's usage readout (shown in TRACKS)
// and their active Session — computed in ONE place for the two
// consumers that must agree on it: the `(app)` layout's first paint and the
// `GET /api/chrome` refetch the shell performs per navigation.

import { getActiveSession, type Database } from '@liedmotif/db';
import type { GetChromeData } from '@liedmotif/shared';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { cachedOwnerUsageTracks, toSessionSummary } from '@/lib/sessions';

export async function loadAppChrome(db: Database, ownerUserId: string): Promise<GetChromeData> {
  const [activeSession, usage] = await Promise.all([
    getActiveSession(db, { ownerUserId }),
    cachedOwnerUsageTracks(db, ownerUserId, getTypicalTracksPerMusicRequest()),
  ]);
  return { usage, activeSession: activeSession ? toSessionSummary(activeSession) : null };
}
