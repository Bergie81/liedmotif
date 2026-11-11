// Read or set the owner's first-login onboarding stamp, for testing the flow.
//
//   npm run onboarding:state              show it
//   npm run onboarding:state -- complete  mark it done (the app stops diverting to /welcome)
//   npm run onboarding:state -- clear     forget it (onboarding runs again once web restarts)
//
// `complete` writes exactly what the flow's last screen writes, and `clear` removes
// only that one `user_settings` row — no profile, People, limits or credential is
// touched either way. Targets whatever `DATABASE_URL` points at, so it works on the
// throwaway demo instance as well as the real one.

import { and, eq } from 'drizzle-orm';
import {
  adminProfile,
  completeOnboarding,
  createDb,
  createPool,
  getOnboardingState,
  userSettings,
  USER_SETTINGS_KEYS,
} from '@liedmotif/db';

type Action = 'show' | 'complete' | 'clear';

function parseAction(argv: readonly string[]): Action {
  const arg = argv.find((value) => !value.startsWith('-')) ?? 'show';
  if (arg === 'show' || arg === 'complete' || arg === 'clear') return arg;
  throw new Error(`unknown action "${arg}" — use show, complete, or clear`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const action = parseAction(process.argv.slice(2));

  const pool = createPool(databaseUrl);
  const db = createDb(pool);
  try {
    const [admin] = await db.select({ userId: adminProfile.userId }).from(adminProfile).limit(1);
    if (!admin) {
      console.log('no admin yet — this instance has not run /setup, so onboarding cannot apply');
      return;
    }

    if (action === 'clear') {
      await db
        .delete(userSettings)
        .where(
          and(
            eq(userSettings.ownerUserId, admin.userId),
            eq(userSettings.key, USER_SETTINGS_KEYS.onboarding),
          ),
        );
      console.log(
        'cleared — restart web (a running one remembers completion), then the next visit runs onboarding again',
      );
    } else if (action === 'complete') {
      const state = await completeOnboarding(db, admin.userId);
      console.log(`completed at ${state.completedAt} — the app no longer diverts to /welcome`);
    }

    const state = await getOnboardingState(db, admin.userId);
    console.log(
      state.completedAt ? `onboarding: complete (${state.completedAt})` : 'onboarding: not done',
    );
  } finally {
    await pool.end();
  }
}

await main();
