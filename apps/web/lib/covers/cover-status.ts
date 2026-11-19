// The shared read plan behind the session and playlist cover-status polls: the
// subject-independent reads (limits, usage view, People availability) and the caller's
// subject-specific ones gather in ONE Promise.all wave — the poll is advisory
// and lock-free, so nothing here may serialize. The usage view chains on the
// limits read inside the same wave.

import {
  coverReferencesAvailable,
  coverUsageView,
  getUsageLimits,
  type Database,
} from '@liedmotif/db';

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
  const [
    limits,
    live,
    latestRegeneration,
    usageView,
    peopleReferencesAvailable,
    generated,
    uploaded,
  ] = await Promise.all([
    limitsRead,
    subject.live(),
    subject.latestRegeneration(),
    limitsRead.then((instanceLimits) =>
      coverUsageView(db, { ownerUserId, instanceLimits, now: new Date() }),
    ),
    coverReferencesAvailable(db, ownerUserId),
    subject.generatedHistory(),
    subject.uploadedHistory(),
  ]);
  return {
    limits,
    live,
    latestRegeneration,
    usageView,
    peopleReferencesAvailable,
    generated,
    uploaded,
  };
}
