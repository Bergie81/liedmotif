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

// The first-run setup routes answer before `APP_PUBLIC_URL` is authority over
// anything: the image still ships the localhost default while the operator
// browses by LAN IP.
describe('refuseSetupCrossOrigin', () => {
  const post = (origin: string, url = 'http://192.168.1.10/api/setup') =>
    refuseSetupCrossOrigin(new Request(url, { method: 'POST', headers: { origin } }));

  it('accepts the host the request was addressed to, whatever the scheme', () => {
    // TLS terminates at the proxy: the browser reports https on a plain-http hop.
    expect(post('http://192.168.1.10')).toBeNull();
    expect(post('https://192.168.1.10')).toBeNull();
    expect(post('http://box.local:2206', 'http://box.local:2206/api/setup')).toBeNull();
  });

  it('still refuses a foreign host and a mismatched port', () => {
    for (const origin of ['https://evil.example', 'http://192.168.1.10:2206', 'null']) {
      expect(post(origin)?.status, origin).toBe(403);
    }
  });

  it('answers in the shape the setup wizard reads', async () => {
    expect(await post('https://evil.example')?.json()).toEqual({
      ok: false,
      error: 'Cross-origin request refused.',
    });
  });
});
