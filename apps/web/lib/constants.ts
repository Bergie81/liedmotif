// Shared client/server constants for the web app.

/**
 * What a fresh instance calls itself. One deployment is one instance, so
 * nothing asks for or edits this; it exists because diagnostics and the Settings hub
 * name the running instance.
 */
export const DEFAULT_INSTANCE_NAME = 'Liedmotif';

/** The one message every dead invite, reset, or confirm link gets — opaque by design. */
export const INVALID_LINK_MESSAGE = 'This link is no longer valid.';

/**
 * What a disabled account is told when an API refuses it. Distinct from every
 * budget refusal on purpose: a disabled account is not a limit that will refill,
 * so it must never be reported as one.
 */
export const ACCOUNT_DISABLED_MESSAGE = 'This account is disabled. Ask the owner to re-enable it.';

/**
 * Header the first-run screens carry the operator's `SETUP_TOKEN` in. It lives
 * here rather than beside the server-side comparison so the setup form can name
 * it without pulling `node:crypto` into the client bundle.
 */
export const SETUP_TOKEN_HEADER = 'x-setup-token';

/** Header the host cron carries `ALERT_CHECK_TOKEN` in for `GET /api/alerts/check`. */
export const ALERT_TOKEN_HEADER = 'x-alert-token';

/** Home's Jump back in: recent Sessions shown on desktop, and below `desk`,
 * where the rail stacks above the create card. */
export const RECENT_SESSIONS_LIMIT = 4;
export const MOBILE_RECENT_SESSIONS_LIMIT = 3;

/** My Sessions' History section below `desk`; older ones are reached by search. */
export const MOBILE_EARLIER_SESSIONS_LIMIT = 10;
