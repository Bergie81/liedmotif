import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refuseCrossOrigin, refuseSetupCrossOrigin } from './api-response';

// The CSRF second layer. `SameSite=Lax` is the first, and it
// degrades quietly — this is the check that keeps working when it does.

const PUBLIC_URL = 'https://music.example';

function requestWith(headers: Record<string, string>, method = 'POST'): Request {
  return new Request('https://music.example/api/sessions', { method, headers });
}

let previous: string | undefined;

beforeEach(() => {
  previous = process.env.APP_PUBLIC_URL;
  process.env.APP_PUBLIC_URL = PUBLIC_URL;
});
afterEach(() => {
  if (previous === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = previous;
});

describe('refuseCrossOrigin', () => {
  it('allows a request with no Origin at all', () => {
    // Same-origin GETs and every non-browser client (curl, the healthcheck).
    expect(refuseCrossOrigin(requestWith({}))).toBeNull();
  });

  it('allows the instance’s own origin, default port and all', () => {
    expect(refuseCrossOrigin(requestWith({ origin: PUBLIC_URL }))).toBeNull();
    expect(refuseCrossOrigin(requestWith({ origin: 'https://music.example:443' }))).toBeNull();
  });

  // The byte-serving exception: audio, avatars and downloads are GETs, and a
  // forged read is not CSRF — the response carries no CORS header for a foreign
  // page to read.
  it('never refuses a safe method, whatever the Origin says', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(refuseCrossOrigin(requestWith({ origin: 'https://evil.example' }, method))).toBeNull();
    }
  });

  it('refuses another site, another scheme, and an opaque origin', () => {
    for (const origin of [
      'https://evil.example',
      'https://music.example.evil.test',
      // Downgraded scheme: the cookie loses `Secure` exactly here.
      'http://music.example',
      'null',
      '',
    ]) {
      const refusal = refuseCrossOrigin(requestWith({ origin }));
      expect(refusal?.status, origin).toBe(403);
    }
  });

  it('compares against APP_PUBLIC_URL including a non-default port', () => {
    process.env.APP_PUBLIC_URL = 'http://192.168.1.10:2206';
    expect(refuseCrossOrigin(requestWith({ origin: 'http://192.168.1.10:2206' }))).toBeNull();
    expect(refuseCrossOrigin(requestWith({ origin: 'http://192.168.1.10' }))?.status).toBe(403);
  });
});

// The first-run setup routes accept an `Origin` whose host is the host
// `APP_PUBLIC_URL` names, whatever its scheme, because TLS ends at the proxy.
describe('refuseSetupCrossOrigin', () => {
  // Each request is addressed to the host its `Origin` names, so a pass can
  // only come from the `APP_PUBLIC_URL` host, never from the addressed host.
  const post = (origin: string) => {
    const addressed = origin === 'null' ? 'http://192.168.1.10' : origin;
    return refuseSetupCrossOrigin(
      new Request(`${addressed}/api/setup`, { method: 'POST', headers: { origin } }),
    );
  };

  const hosts = [
    '192.168.1.10',
    '[::1]:2206',
    'localhost:2206',
    'music.example',
    'evil.example',
    'box.local:2206',
  ];

  it.each(hosts)(
    'accepts a setup post from %s when APP_PUBLIC_URL names it, whatever the scheme',
    (host) => {
      // TLS terminates at the proxy: the browser reports https on a plain-http hop.
      process.env.APP_PUBLIC_URL = `https://${host}`;
      expect(post(`http://${host}`)).toBeNull();
      expect(post(`https://${host}`)).toBeNull();
    },
  );

  it.each(hosts)('refuses a setup post from %s when APP_PUBLIC_URL names another host', (host) => {
    for (const configured of hosts.filter((other) => other !== host)) {
      process.env.APP_PUBLIC_URL = `http://${configured}`;
      expect(post(`http://${host}`)?.status, `${host} vs ${configured}`).toBe(403);
      expect(post(`https://${host}`)?.status, `${host} vs ${configured}`).toBe(403);
    }
  });

  it('refuses a different port on the configured host, and an opaque Origin', () => {
    process.env.APP_PUBLIC_URL = 'http://192.168.1.10';
    for (const origin of ['http://192.168.1.10:2206', 'null']) {
      expect(post(origin)?.status, origin).toBe(403);
    }
  });

  it('accepts a setup post with no Origin at all', () => {
    expect(
      refuseSetupCrossOrigin(new Request('http://192.168.1.10/api/setup', { method: 'POST' })),
    ).toBeNull();
  });

  it('answers in the shape the setup wizard reads', async () => {
    expect(await post('https://evil.example')?.json()).toEqual({
      ok: false,
      error: 'Cross-origin request refused.',
    });
  });
});
