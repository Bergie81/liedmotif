// Admin password reset CLI (no-email recovery).
//
// Run inside the deployment with local container access; it needs no account
// email. Bundled into the worker image by tsup, so:
//
//   read -rs ADMIN_RESET_PASSWORD && export ADMIN_RESET_PASSWORD
//   docker compose exec -e ADMIN_RESET_PASSWORD \
//     worker node dist/reset-admin-password.js --email admin@example.com
//   unset ADMIN_RESET_PASSWORD
//
// The new password is read from the ADMIN_RESET_PASSWORD env var (never passed on
// the command line, where it would land in shell history / the process list). The
// email is optional when there is a single admin. A SAFE audit line is logged via
// the shared JSON logger — it carries the admin id/email but never the password
// (the logger also redacts secrets defensively).
//
// The reset signs that admin out everywhere: it revokes their sign-in sessions
// too, so an operator recovering a possibly-stolen account actually gets it back.

import { assertNotTestDatabase, createDb, createPool } from '@liedmotif/db';
import { AdminNotFoundError, WeakPasswordError, resetAdminPassword } from '@liedmotif/db/admin';
import { createLogger } from '@liedmotif/shared';

const log = createLogger({ name: 'admin-reset' });

/** Parse `--email <value>` / `--email=value` from argv; returns undefined if absent. */
function parseEmailArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--email');
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith('--email='));
  return inline ? inline.slice('--email='.length) : undefined;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const newPassword = process.env.ADMIN_RESET_PASSWORD;
  if (!newPassword) {
    log.error('set ADMIN_RESET_PASSWORD to the new password (not passed as an argument)');
    process.exitCode = 1;
    return;
  }

  const email = parseEmailArg(process.argv.slice(2));
  assertNotTestDatabase(databaseUrl);
  const pool = createPool(databaseUrl, { applicationName: 'liedmotif-admin-reset', max: 2 });
  try {
    const result = await resetAdminPassword(createDb(pool), { email, newPassword });
    // Safe audit line: identity only, never the password.
    log.info('admin password reset', { userId: result.userId, email: result.email });
  } catch (err) {
    if (err instanceof AdminNotFoundError || err instanceof WeakPasswordError) {
      log.error('admin password reset rejected', { reason: err.message });
    } else {
      log.error('admin password reset failed', { err });
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
