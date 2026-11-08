// Server-side configuration helpers for the web process. Import only from server
// code (route handlers, server components) — never the client.

import { loadEncryptionKey } from '@liedmotif/db';
import { isLoopbackHost } from '@liedmotif/providers';
import { readIntEnv } from '@liedmotif/shared';

/**
 * `.env.example` ships recognizable placeholder secrets. Anyone can read them,
 * so signing sessions with one lets an attacker mint a valid admin cookie —
 * running with a placeholder must be a boot failure, not a silent weakness.
 */
const PLACEHOLDER_SECRET_PATTERN = /change-me/i;

/** `openssl rand -base64 32` yields 44 chars; 32 is the documented floor. */
const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * The Better Auth session-signing secret. Prefers `BETTER_AUTH_SECRET` (the name
 * Better Auth documents) and falls back to the generic `APP_SECRET`. Fails
 * loudly on a misconfigured instance instead of signing sessions with a weak
 * secret: missing/blank (including whitespace-only), a known `.env.example`
 * placeholder, and too-short values are all rejected (error messages never echo
 * the value). Validated at server boot via `instrumentation.ts` and again on
 * first auth use.
 */
export function getAuthSecret(): string {
  // Trim before selection and validation: a whitespace-only value must fall
  // back / fail like a missing one, padding must not defeat the length floor,
  // and the trimmed value is what signs sessions — stray whitespace from an env
  // file never silently becomes part of the signing key.
  const secret =
    (process.env.BETTER_AUTH_SECRET ?? '').trim() || (process.env.APP_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET (or APP_SECRET) must be set');
  }
  if (PLACEHOLDER_SECRET_PATTERN.test(secret)) {
    throw new Error(
      'BETTER_AUTH_SECRET/APP_SECRET is still the .env.example placeholder — ' +
        'a publicly known signing secret allows session forgery. Generate a real ' +
        'one: `openssl rand -base64 32`',
    );
  }
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET/APP_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} ` +
        'characters. Generate one: `openssl rand -base64 32`',
    );
  }
  return secret;
}

/** The public URL the instance is served from (auth base URL / absolute links). */
export function getPublicUrl(): string {
  return process.env.APP_PUBLIC_URL?.trim() || 'http://localhost:2206';
}

/**
 * Boot-time posture check for `APP_PUBLIC_URL`. Better Auth derives
 * its secure-cookie behavior from this URL's scheme: an instance served over TLS
 * (Caddy) but still configured with the shipped `http://localhost:2206` default
 * issues session cookies WITHOUT the `Secure` flag. Garbage values fail the boot;
 * a plain-http NON-loopback URL fails a PRODUCTION boot and warns everywhere
 * else — a trusted-LAN plain-http deployment stays a legitimate, if weak,
 * self-hosting choice, but it has to say so through `ALLOW_INSECURE_PUBLIC_URL`
 * rather than by ignoring a log line. The most likely misconfiguration — Caddy
 * serving `https://<APP_DOMAIN>` while `APP_PUBLIC_URL` still points at the
 * localhost default — is caught by cross-checking `APP_DOMAIN` (Compose passes
 * it to the web container).
 */
export function assertPublicUrlPosture(warn: (message: string) => void = console.warn): void {
  const raw = getPublicUrl();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_PUBLIC_URL must be an absolute http(s):// URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('APP_PUBLIC_URL must use http:// or https://');
  }
  // Loopback per the cookie threat model: localhost is a secure context anyway.
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_PUBLIC_URL !== '1') {
      throw new Error(
        'APP_PUBLIC_URL is plain http on a non-local host in production — session ' +
          'cookies would carry no Secure flag, so anyone on the path can read and ' +
          'replay them. Serve the instance over TLS and set ' +
          'APP_PUBLIC_URL=https://<your domain>, or set ALLOW_INSECURE_PUBLIC_URL=1 ' +
          'to accept the weaker posture on a trusted network.',
      );
    }
    warn(
      `APP_PUBLIC_URL is plain http on a non-local host — session cookies will NOT ` +
        `carry the Secure flag. If this instance is served over TLS (e.g. through ` +
        `Caddy), set APP_PUBLIC_URL=https://<your domain> so auth cookies and ` +
        `trusted origins match the real origin.`,
    );
  }

  // Caddy serves https://<APP_DOMAIN>; when the operator points it at a real
  // domain but leaves APP_PUBLIC_URL alone, cookies stay non-Secure and the
  // HTTPS origin is untrusted for auth. This is the misconfiguration the docs
  // warn about — say it at boot too.
  const appDomain = process.env.APP_DOMAIN?.trim().toLowerCase();
  if (
    appDomain &&
    appDomain !== 'localhost' &&
    (url.protocol !== 'https:' || url.hostname.toLowerCase() !== appDomain)
  ) {
    warn(
      `APP_DOMAIN is "${appDomain}" (Caddy serves https://${appDomain}) but ` +
        `APP_PUBLIC_URL is "${raw}". Sign-in and secure cookies follow ` +
        `APP_PUBLIC_URL — set APP_PUBLIC_URL=https://${appDomain} so they match ` +
        `the real origin.`,
    );
  }
}

/**
 * Boot-time warning for a real `APP_DOMAIN` that Caddy publishes on this machine
 * alone, which leaves the site unreachable from every other device with nothing
 * else to say why. Compose passes the Caddy ports and `TAILSCALE_IP` to the web
 * container for this check.
 */
export function assertCaddyPortsPosture(warn: (message: string) => void = console.warn): void {
  const appDomain = process.env.APP_DOMAIN?.trim().toLowerCase();
  // Caddy publishes HTTPS on loopback while its port is unset, and the Tailscale
  // override publishes on TAILSCALE_IP whatever it says. A value such as
  // 127.0.0.1:443 set by hand is a choice (a tunnel on this machine), and so is
  // public HTTPS with no HTTP port (a DNS-01 certificate).
  if (
    appDomain &&
    appDomain !== 'localhost' &&
    !process.env.CADDY_HTTPS_PORT?.trim() &&
    !process.env.TAILSCALE_IP?.trim()
  ) {
    warn(
      `APP_DOMAIN is "${appDomain}" but CADDY_HTTPS_PORT is not set, so ` +
        `https://${appDomain} answers only on this machine. Set ` +
        `CADDY_HTTP_PORT=80 and CADDY_HTTPS_PORT=443 in .env and run docker compose ` +
        `up -d (set SETUP_TOKEN first when the internet can reach it). If a tunnel on ` +
        `this machine is the way in, set them to 127.0.0.1:80 and 127.0.0.1:443 instead.`,
    );
  }
}

/**
 * The SMTP connection and sender for account email, or `null` when account
 * email is off. Blank counts as unset, like every optional `.env` setting.
 * `url` carries the SMTP password: it never reaches a log or an error message.
 */
export function accountEmailConfig(
  env: Record<string, string | undefined> = process.env,
): { url: string; from: string } | null {
  const url = env.SMTP_URL?.trim();
  const from = env.MAIL_FROM?.trim();
  return url && from ? { url, from } : null;
}

/**
 * Singing in the owner's own voice is offered only when the instance
 * sets `OWN_VOICE_ENABLED=true`: the provider's voice clone does not sound good
 * enough to offer by default. Stored Voice Profiles are kept either way.
 */
export function ownVoiceEnabled(): boolean {
  return process.env.OWN_VOICE_ENABLED?.trim().toLowerCase() === 'true';
}

/** Account email is on when both `SMTP_URL` and `MAIL_FROM` are set. */
export function isAccountEmailEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return accountEmailConfig(env) !== null;
}

/**
 * Boot-time check that account email is either fully configured or fully off.
 * With only one of the two set the instance would quietly run with email off
 * while the operator believes it is on. An unparseable `SMTP_URL` fails too:
 * nodemailer would attach it, password included, to the error it throws, and
 * Node prints it in a deprecation warning — so neither message echoes it.
 */
export function assertAccountEmailPosture(
  env: Record<string, string | undefined> = process.env,
): void {
  const url = env.SMTP_URL?.trim();
  const hasFrom = Boolean(env.MAIL_FROM?.trim());
  if (Boolean(url) !== hasFrom) {
    const [missing, present] = url ? ['MAIL_FROM', 'SMTP_URL'] : ['SMTP_URL', 'MAIL_FROM'];
    throw new Error(
      `${missing} is missing: account email needs both SMTP_URL and MAIL_FROM. ` +
        `Set ${missing}, or clear ${present} to keep account email off.`,
    );
  }
  if (url && !URL.canParse(url)) {
    throw new Error(
      'SMTP_URL is not a valid URL. Percent-encode special characters in the user ' +
        'name and password (`@` as %40, `/` as %2F, `#` as %23).',
    );
  }
}

/**
 * The token that arms Instance alerts, or `null` while they are off. Blank counts
 * as unset, and stray whitespace from an env file never becomes part of the token.
 */
export function alertCheckToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.ALERT_CHECK_TOKEN?.trim() || null;
}

/**
 * Where Instance alerts POST, or `null` when no webhook is set up. It may carry the
 * receiver's own token: it never reaches a log or an error message.
 */
export function alertWebhookUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.ALERT_WEBHOOK_URL?.trim() || null;
}

/**
 * Boot-time check that Instance alerts are either armed with somewhere to go or
 * fully off: half-armed alerting is precisely the silence the feature exists to
 * break. Plain `http` is allowed because a receiver on the LAN is the intended
 * target. The webhook URL may carry the receiver's own token, so no message
 * echoes it.
 */
export function assertInstanceAlertsPosture(
  env: Record<string, string | undefined> = process.env,
): void {
  const token = alertCheckToken(env);
  const webhookUrl = alertWebhookUrl(env);
  if (webhookUrl && !token) {
    throw new Error(
      'ALERT_WEBHOOK_URL is set but ALERT_CHECK_TOKEN is not: alerts are armed only by the ' +
        'token. Set ALERT_CHECK_TOKEN, or clear ALERT_WEBHOOK_URL.',
    );
  }
  if (token && !webhookUrl && !accountEmailConfig(env)) {
    throw new Error(
      'ALERT_CHECK_TOKEN is set but alerts have nowhere to go. Set ALERT_WEBHOOK_URL, turn on ' +
        'account email (SMTP_URL and MAIL_FROM), or clear ALERT_CHECK_TOKEN.',
    );
  }
  if (webhookUrl) {
    const protocol = URL.parse(webhookUrl)?.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error('ALERT_WEBHOOK_URL must be an absolute http:// or https:// URL.');
    }
  }
}

/** Today's deployment: Caddy is the one ingress, and it appends exactly one hop. */
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** A chain longer than this is a typo, not a topology. */
const MAX_TRUSTED_PROXY_HOPS = 8;

/**
 * How many proxies between the client and this process may be trusted to have
 * written `x-forwarded-for` — one for the shipped Caddy-only deployment, two
 * behind a cloud load balancer (client → LB → Caddy), and 0 when the app is
 * reached directly. `clientIp` keys every rate limiter on the hop this count
 * selects.
 *
 * A malformed value throws (validated at boot like the secrets above), because
 * the wrong hop count is exactly the silent failure this variable exists to
 * prevent: too few and every client keys as the load balancer (ten failed
 * logins lock out everyone), too many and the key comes from the caller's own
 * header.
 */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  return readIntEnv(
    'TRUSTED_PROXY_HOPS',
    { fallback: DEFAULT_TRUSTED_PROXY_HOPS, min: 0, max: MAX_TRUSTED_PROXY_HOPS },
    env,
  );
}

let cachedKey: Buffer | undefined;

/**
 * The AES-256-GCM master key for DB-stored credential secrets, validated and
 * cached. Throws (fail fast) when `CREDENTIAL_ENCRYPTION_KEY` is missing or not a
 * base64 32-byte key — callers that store/read DB secrets surface a sanitized
 * config error rather than proceeding with a broken key.
 */
export function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    cachedKey = loadEncryptionKey();
  }
  return cachedKey;
}
