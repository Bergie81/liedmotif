// Bootstrap authority for first-run setup (server-only).
//
// `/api/setup` creates the sole administrator while none exists, so on an
// internet-exposed instance whoever reaches it first wins — the advisory lock
// prevents two winners but does not authenticate which one. `SETUP_TOKEN` makes
// that race authenticated: only a request carrying the operator's token can
// claim the administrator. Unset, every request passes, which is what keeps LAN
// installs on the open wizard.
//
// One function owns both halves of the gate, so a caller cannot check the token
// and then forget to refuse. Neither the configured token nor a presented one is
// logged or echoed anywhere.

import { NextResponse } from 'next/server';
import { SETUP_TOKEN_HEADER } from '@/lib/constants';
import { requestCarriesToken } from '@/lib/token-compare';

/**
 * The refusal a setup route must return, or null when the request may proceed.
 * One response covers every rejection reason, so a missing token and a wrong
 * token are indistinguishable and nothing confirms that a guess got closer.
 */
export function setupTokenRefusal(request: Request): NextResponse | null {
  // Trimmed for the same reason the auth secret is: stray whitespace from an
  // env file must not silently become part of the token the operator types.
  const configured = process.env.SETUP_TOKEN?.trim();
  if (!configured) return null;

  if (requestCarriesToken(request, SETUP_TOKEN_HEADER, configured)) return null;

  return NextResponse.json({ ok: false, error: 'Setup is not available.' }, { status: 403 });
}

/**
 * The boot-time posture line for an instance nobody has claimed yet, or null
 * when there is nothing to say. Unset is the default, so a fresh deploy hands
 * the administrator account to whoever reaches `/api/setup` first — that has to
 * be visible while the operator is still watching the logs, not inferred later
 * from an admin account they did not create.
 */
export function unclaimedSetupWarning(adminExists: boolean): string | null {
  if (adminExists) return null;
  if (process.env.SETUP_TOKEN?.trim()) return null;
  return (
    'No administrator exists yet and SETUP_TOKEN is unset — the first request to ' +
    '/api/setup claims this instance. Set SETUP_TOKEN before exposing it beyond a ' +
    'trusted network, or finish the setup wizard now.'
  );
}
