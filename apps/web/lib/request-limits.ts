// Process-local rate limiters for the unauthenticated endpoints (setup + login)
// and for the authenticated doors whose cost the usage windows do not meter:
// session creation, Change Vibe and the Assistant.
//
// The setup routes reach out to provider APIs (validation) or create the admin
// (submit); login guards the password against online brute force. Those are
// throttled per client IP. Module-level singletons keep the window state across
// requests within the process — the right scope for a single-instance
// self-hosted app (no Redis).

import { createRateLimiter } from '@liedmotif/shared';
import { clientIpFromHeaders } from '@/lib/http';

/** Provider-validation calls: a modest burst per minute. */
export const validateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

/** Admin-creation submits: tight — only a few attempts per minute. */
export const submitLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

/**
 * Sign-in FAILURES: only rejected attempts consume budget, so real
 * users (and the e2e suite) signing in successfully are never throttled, while
 * password guessing locks the caller's IP out for the window. Applied in the
 * auth catch-all route — explicit and app-level, not Better Auth's default
 * (which, behind Caddy, would key on the proxy address).
 *
 * Keyed on the client IP ONLY. A second window per account would blunt guessing
 * spread across many addresses, but on an instance with no public sign-up it
 * buys that at the price of a targeted lockout: anyone who knows a member's
 * email could keep that member signed out with failed attempts of their own.
 */
export const loginFailureLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });

/**
 * Invite-claim, password-reset, and email-confirm submits: unauthenticated and
 * token-guessing bait, so every attempt (not just failures) consumes budget.
 * Legitimate use is one or two submits per link.
 */
export const linkTokenLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });

/**
 * CSP violation reports. The endpoint only writes log lines, so the budget is
 * there to bound them: one broken page load can emit a burst, and the reports
 * are posted by any browser that loaded the app, authenticated or not.
 */
export const cspReportLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

/**
 * Forgot-password submits, per IP. Every one may become a mail to a real inbox,
 * and the per-address budget below does nothing against one caller spraying
 * many addresses, so every attempt consumes budget.
 */
export const forgotPasswordLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });

/**
 * Forgot-password mails, per address. Past the budget the route still answers
 * as usual and simply mails nothing, so the throttle says nothing about whether
 * the address has an account.
 */
export const forgotPasswordMailLimiter = createRateLimiter({ limit: 3, windowMs: 60 * 60_000 });

/**
 * Confirm-link mails, per User. Each send is a mail to a real inbox, so the
 * budget bounds how often one account can make the instance write to it.
 */
export const confirmLinkMailLimiter = createRateLimiter({ limit: 3, windowMs: 15 * 60_000 });

/** Change password's reset-link mails, per User — the same bound as confirm links. */
export const resetLinkMailLimiter = createRateLimiter({ limit: 3, windowMs: 15 * 60_000 });

/**
 * The /join, /reset, and /confirm PAGE renders. Each render answers whether a
 * token is claimable, so an unthrottled page would be a token-validity oracle
 * beside the throttled submit. Looser than the submit budget — a legitimate
 * claimer may reload a few times — and over budget the page shows the same
 * opaque refusal a dead link gets.
 */
const linkLookupLimiter = createRateLimiter({ limit: 30, windowMs: 15 * 60_000 });

/** One shared gate for the /join, /reset, and /confirm page renders. */
export function linkTokenLookupAllowed(headers: Headers): boolean {
  return linkLookupLimiter.check(clientIpFromHeaders(headers)).allowed;
}

/**
 * Session creation, per OWNER. Creating a Session is gated on
 * MUSIC headroom, which text-LLM use never decrements, and each new Session
 * supersedes the last — so a tight create loop spends expansion and naming LLM
 * calls indefinitely against a budget that never moves. Keyed on the owner
 * rather than the IP: the spend is the owner's, and every caller here is
 * authenticated. ONE budget across every door that creates a Session (Start
 * Session, More Like This), because they share the spend it bounds. Sized far
 * above human cadence — each Session costs an LLM round trip to derive and a
 * listen to judge, so nobody starts ten in a minute.
 */
export const sessionCreateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

/**
 * Change Vibe, per OWNER. Each change makes a writing-AI call (expansion or a
 * picks adjustment) that the usage windows, counting music tasks, never meter,
 * so a script or a stuck client could repeat it indefinitely on the Admin's
 * key. Its own budget, apart from Session creation: the two are separate
 * actions, and using up one leaves the other. The same size, far above anyone
 * changing the vibe by hand.
 */
export const changeVibeLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

/**
 * Assistant messages, per USER. Each one is a tool-calling exchange with the
 * text LLM, which the usage windows — counting music tasks — never meter. This
 * bounds a burst from any one account, the Admin's included. Sized well above
 * a real chat: nobody reads twenty answers in five minutes.
 */
export const assistantLimiter = createRateLimiter({ limit: 20, windowMs: 5 * 60_000 });

/**
 * Custom cover style rewrites on save, per USER. Each changed definition is a
 * text-LLM call no usage window meters; past the burst the definition saves as
 * written. Sized far above human cadence: nobody rewords a style ten times a minute.
 */
export const coverDefinitionEnhanceLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
