// Request-scoped (react.cache) reads shared across the guards, the app layout,
// and the settings loaders. One server render legitimately asks these questions
// several times — defense-in-depth guards, the layout chrome, the settings hub —
// and each answer must come from ONE query per request. Nothing here is shared
// across requests or users. (The usage computation itself lives in
// `lib/sessions/sessions.ts` as `cachedOwnerUsageTracks` — it needs that module's
// internals, and importing it here would cycle.) Every read is keyed by its db
// handle too, so a caller holding a non-default handle (tests) never shares an
// answer with the request's own reads.

import { cache } from 'react';
import { getListenerProfile, resolveUserProfile, type Database } from '@liedmotif/db';

/**
 * One clock per request: every budget/usage readout in a render counts its
 * windows from the same instant, so two readouts can never straddle a
 * day/month boundary.
 */
export const requestNow = cache(() => new Date());

/**
 * Role + disabled state, once per request. The per-REQUEST freshness is a
 * deliberate security tradeoff — a disable must take effect on the next
 * request, so this is never memoized beyond the request (see `lib/auth/session.ts`).
 */
export const cachedUserProfile = cache(async (db: Database, userId: string) =>
  resolveUserProfile(db, userId),
);

/** The listener profile (artist name etc.), once per request. */
export const cachedListenerProfile = cache(async (db: Database, userId: string) =>
  getListenerProfile(db, userId),
);
