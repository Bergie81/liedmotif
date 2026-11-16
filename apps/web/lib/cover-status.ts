// The shared read plan behind the session and playlist cover-status polls: the
// subject-independent reads (limits, usage view, enhancement) and the caller's
// subject-specific ones gather in ONE Promise.all wave — the poll is advisory
// and lock-free, so nothing here may serialize. The usage view chains on the
// limits read inside the same wave.

import { coverUsageView, getUsageLimits, type Database } from '@liedmotif/db';
import { resolveCoverEnhancement } from '@/lib/cover-enhancement';

export async function loadCoverStatusReads<Live, Latest, Generated, Uploaded>(
  db: Database,
  ownerUserId: string,
  subject: {
    live: () => Promise<Live>;
    latestRegeneration: () => Promise<Latest>;
    generatedHistory: () => Promise<Generated>;
    uploadedHistory: () => Promise<Uploaded>;
  },
) {
  const limitsRead = getUsageLimits(db);
  const [limits, live, latestRegeneration, usageView, enhancement, generated, uploaded] =
    await Promise.all([
      limitsRead,
      subject.live(),
      subject.latestRegeneration(),
      limitsRead.then((instanceLimits) =>
        coverUsageView(db, { ownerUserId, instanceLimits, now: new Date() }),
      ),
      resolveCoverEnhancement(db, ownerUserId),
      subject.generatedHistory(),
      subject.uploadedHistory(),
    ]);
  return { limits, live, latestRegeneration, usageView, enhancement, generated, uploaded };
}
