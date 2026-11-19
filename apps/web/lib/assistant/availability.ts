// Whether a user has the Assistant at all (server-only), asked once per
// request: the app shell asks for its launcher, and the settings hub and the
// Assistant's settings page ask whether to offer themselves.

import { cache } from 'react';
import { resolveAssistantStanding, type Database, type UserRole } from '@liedmotif/db';
import { getLlmProvider } from '@/lib/providers/providers';
import { requestNow } from '@/lib/request-cache';

/**
 * `available` is true when a text LLM is set up and this user's access is on.
 * `standing` is what is left of their allowance today. A read that fails
 * counts as no Assistant rather than failing the page that asked.
 */
export const cachedAssistantAvailability = cache(
  async (db: Database, userId: string, role: UserRole) => {
    const [llm, standing] = await Promise.all([
      getLlmProvider().catch(() => null),
      resolveAssistantStanding(db, { userId, role, now: requestNow() }).catch(() => null),
    ]);
    return { available: llm !== null && standing?.enabled === true, standing };
  },
);
