// Boot-time auth-secret validation: a known `.env.example`
// placeholder or a too-short value must fail fast — running with a publicly
// known signing secret would let anyone mint a valid admin session cookie.
// Plus the APP_PUBLIC_URL posture check: garbage fails the boot;
// plain http on a non-local host warns about the missing Secure cookie flag.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertCheckToken,
  alertWebhookUrl,
  assertAccountEmailPosture,
  assertCaddyPortsPosture,
  assertInstanceAlertsPosture,
  assertPublicUrlPosture,
  getAuthSecret,
  isAccountEmailEnabled,
  trustedProxyHops,
} from './env';

const STRONG_SECRET = 'c3Ryb25nLXJhbmRvbS1zZWNyZXQtZm9yLXRlc3RzLQ=='; // 44 chars, base64-looking

describe('getAuthSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a strong BETTER_AUTH_SECRET', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', STRONG_SECRET);
    vi.stubEnv('APP_SECRET', '');
    expect(getAuthSecret()).toBe(STRONG_SECRET);
  });

  it('falls back to APP_SECRET when BETTER_AUTH_SECRET is unset, blank, or whitespace-only', () => {
    for (const blank of ['', '   ']) {
      vi.stubEnv('BETTER_AUTH_SECRET', blank);
      vi.stubEnv('APP_SECRET', STRONG_SECRET);
      expect(getAuthSecret()).toBe(STRONG_SECRET);
    }
  });

  it('throws when neither secret is set', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    vi.stubEnv('APP_SECRET', '');
    expect(() => getAuthSecret()).toThrow('must be set');
  });

  it('rejects a whitespace-only secret even at valid length', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', ' '.repeat(40));
    vi.stubEnv('APP_SECRET', '');
    expect(() => getAuthSecret()).toThrow('must be set');
  });

  it('validates the trimmed value: padding cannot defeat the length floor', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', `   short-but-not-a-placeholder   `);
    vi.stubEnv('APP_SECRET', '');
    expect(() => getAuthSecret()).toThrow('at least 32');
  });

  it('returns the trimmed secret so stray env whitespace never joins the signing key', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', `  ${STRONG_SECRET}\n`);
    vi.stubEnv('APP_SECRET', '');
    expect(getAuthSecret()).toBe(STRONG_SECRET);
  });

  it('rejects the shipped .env.example placeholders', () => {
    for (const placeholder of [
      'change-me-app-secret-please-generate-a-real-one',
      'change-me-better-auth-secret-please-generate-a-real-one',
    ]) {
      vi.stubEnv('BETTER_AUTH_SECRET', placeholder);
      vi.stubEnv('APP_SECRET', '');
      expect(() => getAuthSecret()).toThrow('placeholder');
    }
  });

  it('rejects a placeholder hiding in the APP_SECRET fallback', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    vi.stubEnv('APP_SECRET', 'Change-Me-later');
    expect(() => getAuthSecret()).toThrow('placeholder');
  });

  it('rejects secrets shorter than 32 characters', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'short-but-not-a-placeholder');
    vi.stubEnv('APP_SECRET', '');
    expect(() => getAuthSecret()).toThrow('at least 32');
  });

  it('never echoes the secret value in the error', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'change-me-app-secret-please-generate-a-real-one');
    vi.stubEnv('APP_SECRET', '');
    try {
      getAuthSecret();
      expect.unreachable('placeholder secret must throw');
    } catch (err) {
      expect(String(err)).not.toContain('change-me-app-secret');
    }
  });
});

describe('assertPublicUrlPosture', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the shipped localhost default and https URLs without warning', () => {
    const warn = vi.fn();
    vi.stubEnv('APP_DOMAIN', '');
    for (const url of [
      '',
      'http://localhost:2206',
      'http://127.0.0.1:2206',
      'https://liedmotif.example',
    ]) {
      vi.stubEnv('APP_PUBLIC_URL', url);
      assertPublicUrlPosture(warn);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws on an unparseable or non-http(s) APP_PUBLIC_URL', () => {
    vi.stubEnv('APP_PUBLIC_URL', 'not a url');
    expect(() => assertPublicUrlPosture(vi.fn())).toThrow('absolute http(s)');
    vi.stubEnv('APP_PUBLIC_URL', 'ftp://liedmotif.example');
    expect(() => assertPublicUrlPosture(vi.fn())).toThrow('http:// or https://');
  });

  it('warns (not throws) on plain http with a non-local host outside production', () => {
    const warn = vi.fn();
    vi.stubEnv('APP_DOMAIN', '');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_PUBLIC_URL', 'http://192.168.1.10:2206');
    assertPublicUrlPosture(warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('Secure');
  });

  it('fails the boot on plain http with a non-local host in production', () => {
    // Cookies silently lose `Secure` here, which is the single control CSRF
    // and session confidentiality both rest on — a warning is not enough once
    // the instance is a deployed one.
    vi.stubEnv('APP_DOMAIN', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_PUBLIC_URL', 'http://liedmotif.example:2206');
    expect(() => assertPublicUrlPosture(vi.fn())).toThrow(/ALLOW_INSECURE_PUBLIC_URL/);
  });

  it('accepts production plain http under the explicit override, still warning', () => {
    const warn = vi.fn();
    vi.stubEnv('APP_DOMAIN', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_PUBLIC_URL', 'http://liedmotif.example:2206');
    vi.stubEnv('ALLOW_INSECURE_PUBLIC_URL', '1');
    assertPublicUrlPosture(warn);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns when Caddy serves a real APP_DOMAIN but APP_PUBLIC_URL is still the default', () => {
    // The most likely copied-.env mistake: HTTPS through Caddy, cookies non-Secure.
    const warn = vi.fn();
    vi.stubEnv('APP_DOMAIN', 'my-host.ts.net');
    vi.stubEnv('APP_PUBLIC_URL', 'http://localhost:2206');
    assertPublicUrlPosture(warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('https://my-host.ts.net');
  });

  it('is silent when APP_PUBLIC_URL matches the served https APP_DOMAIN (or it is localhost)', () => {
    const warn = vi.fn();
    vi.stubEnv('APP_DOMAIN', 'my-host.ts.net');
    vi.stubEnv('APP_PUBLIC_URL', 'https://my-host.ts.net');
    assertPublicUrlPosture(warn);

    vi.stubEnv('APP_DOMAIN', 'localhost');
    vi.stubEnv('APP_PUBLIC_URL', 'http://localhost:2206');
    assertPublicUrlPosture(warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('assertCaddyPortsPosture', () => {
  describe('when Caddy serves a real APP_DOMAIN', () => {
    beforeEach(() => {
      vi.stubEnv('APP_DOMAIN', 'music.example.com');
      vi.stubEnv('CADDY_HTTP_PORT', '');
      vi.stubEnv('CADDY_HTTPS_PORT', '');
      vi.stubEnv('TAILSCALE_IP', '');
    });

    it.each([
      ['both ports are unset', {}],
      ['only the HTTP port is set, so HTTPS stays private', { CADDY_HTTP_PORT: '80' }],
    ])('warns that it answers only on this machine when %s, naming the fix', (_name, env) => {
      const warn = vi.fn();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      assertCaddyPortsPosture(warn);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('CADDY_HTTP_PORT=80');
    });

    it.each([
      ['plain ports', { CADDY_HTTP_PORT: '80', CADDY_HTTPS_PORT: '443' }],
      ['public HTTPS with no HTTP port, as with a DNS-01 certificate', { CADDY_HTTPS_PORT: '443' }],
      [
        'ports kept private on purpose, for a tunnel on this machine',
        { CADDY_HTTP_PORT: '127.0.0.1:80', CADDY_HTTPS_PORT: '127.0.0.1:443' },
      ],
      ['Tailscale mode, which binds its own address', { TAILSCALE_IP: '100.64.0.9' }],
    ])('stays silent under %s', (_name, env) => {
      const warn = vi.fn();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      assertCaddyPortsPosture(warn);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('trustedProxyHops', () => {
  it('defaults to the single-proxy deployment', () => {
    expect(trustedProxyHops({})).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '  ' })).toBe(1);
  });

  it('reads a configured chain length', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' })).toBe(2);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '0' })).toBe(0);
  });

  it('refuses a malformed value instead of silently keying on the wrong hop', () => {
    for (const bad of ['two', '-1', '1.5', '99']) {
      expect(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: bad })).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });
});

describe('account email configuration', () => {
  const SMTP_URL = 'smtps://user:app-password@smtp.example.com:465';
  const MAIL_FROM = 'Liedmotif <liedmotif@example.com>';

  it('is on only when both SMTP_URL and MAIL_FROM are set, blank counting as unset', () => {
    expect(isAccountEmailEnabled({ SMTP_URL, MAIL_FROM })).toBe(true);
    expect(isAccountEmailEnabled({})).toBe(false);
    expect(isAccountEmailEnabled({ SMTP_URL })).toBe(false);
    expect(isAccountEmailEnabled({ SMTP_URL, MAIL_FROM: '  ' })).toBe(false);
    expect(isAccountEmailEnabled({ SMTP_URL: '', MAIL_FROM })).toBe(false);
  });

  it('boots with neither or both set', () => {
    expect(() => assertAccountEmailPosture({})).not.toThrow();
    expect(() => assertAccountEmailPosture({ SMTP_URL: ' ', MAIL_FROM: '' })).not.toThrow();
    expect(() => assertAccountEmailPosture({ SMTP_URL, MAIL_FROM })).not.toThrow();
  });

  it('fails the boot when only one is set, naming the missing one and never echoing SMTP_URL', () => {
    expect(() => assertAccountEmailPosture({ SMTP_URL })).toThrow(/^MAIL_FROM is missing/);
    expect(() => assertAccountEmailPosture({ SMTP_URL })).not.toThrow(/app-password/);
    expect(() => assertAccountEmailPosture({ MAIL_FROM, SMTP_URL: '' })).toThrow(
      /^SMTP_URL is missing/,
    );
  });

  // nodemailer attaches an unparseable URL — password included — to the error
  // it throws, and Node prints it in a deprecation warning.
  it('fails the boot on an SMTP_URL that is not a URL, never echoing it', () => {
    const unencoded = 'smtps://user:pass#word@smtp.example.com:465';
    expect(() => assertAccountEmailPosture({ SMTP_URL: unencoded, MAIL_FROM })).toThrow(
      /^SMTP_URL is not a valid URL/,
    );
    expect(() => assertAccountEmailPosture({ SMTP_URL: unencoded, MAIL_FROM })).not.toThrow(
      /pass#word/,
    );
  });
});

describe('Instance alerts configuration', () => {
  it('trims both values and reads blank as unset', () => {
    expect(alertCheckToken({ ALERT_CHECK_TOKEN: '  a-token\n' })).toBe('a-token');
    expect(alertCheckToken({ ALERT_CHECK_TOKEN: '   ' })).toBeNull();
    expect(alertCheckToken({})).toBeNull();
    expect(alertWebhookUrl({ ALERT_WEBHOOK_URL: ' http://receiver.lan/x ' })).toBe(
      'http://receiver.lan/x',
    );
    expect(alertWebhookUrl({ ALERT_WEBHOOK_URL: '' })).toBeNull();
    expect(alertWebhookUrl({})).toBeNull();
  });
});

describe('assertInstanceAlertsPosture', () => {
  const TOKEN = { ALERT_CHECK_TOKEN: 'a-token' };
  const WEBHOOK = { ALERT_WEBHOOK_URL: 'http://192.168.1.20:8080/liedmotif' };
  const EMAIL = { SMTP_URL: 'smtp://mail.example:587', MAIL_FROM: 'Liedmotif <p@example.test>' };

  it('passes silently when nothing is armed, with or without account email', () => {
    expect(() => assertInstanceAlertsPosture({})).not.toThrow();
    expect(() => assertInstanceAlertsPosture(EMAIL)).not.toThrow();
    expect(() =>
      assertInstanceAlertsPosture({ ALERT_CHECK_TOKEN: '  ', ALERT_WEBHOOK_URL: ' ' }),
    ).not.toThrow();
  });

  it('passes a token with a webhook, with account email, or with both', () => {
    expect(() => assertInstanceAlertsPosture({ ...TOKEN, ...WEBHOOK })).not.toThrow();
    expect(() => assertInstanceAlertsPosture({ ...TOKEN, ...EMAIL })).not.toThrow();
    expect(() => assertInstanceAlertsPosture({ ...TOKEN, ...WEBHOOK, ...EMAIL })).not.toThrow();
  });

  it('fails the boot on a webhook URL without a token', () => {
    expect(() => assertInstanceAlertsPosture(WEBHOOK)).toThrow('ALERT_CHECK_TOKEN');
    expect(() => assertInstanceAlertsPosture({ ...WEBHOOK, ...EMAIL })).toThrow(
      'ALERT_CHECK_TOKEN',
    );
  });

  it('fails the boot on a token with no destination', () => {
    expect(() => assertInstanceAlertsPosture(TOKEN)).toThrow('ALERT_WEBHOOK_URL');
  });

  it('fails the boot on an unparseable or non-http(s) webhook URL, without echoing it', () => {
    for (const url of ['not a url s3cret', 'ftp://receiver.example/s3cret']) {
      let message = '';
      try {
        assertInstanceAlertsPosture({ ...TOKEN, ALERT_WEBHOOK_URL: url });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('ALERT_WEBHOOK_URL');
      expect(message).not.toContain('s3cret');
    }
  });

  it('allows plain http: a receiver on the LAN is the intended target', () => {
    expect(() =>
      assertInstanceAlertsPosture({ ...TOKEN, ALERT_WEBHOOK_URL: 'http://localhost:2586/x' }),
    ).not.toThrow();
  });
});
