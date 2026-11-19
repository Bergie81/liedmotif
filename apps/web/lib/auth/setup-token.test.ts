import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupTokenRefusal, unclaimedSetupWarning } from './setup-token';

// Bootstrap authority for first-run setup. The behaviors that matter are the
// two ends: an instance WITHOUT `SETUP_TOKEN` must keep the open wizard, and an
// instance WITH one must refuse every value that is not the configured token —
// including values of a different length, which a raw `timingSafeEqual` would
// turn into a 500 and a length oracle.
//
// The variable is stubbed rather than assigned: Vitest loads `.env`, so a
// developer whose own instance is token-gated would otherwise fail the
// unconfigured cases locally and pass them in CI.

const TOKEN = 'b1b0f2c6d4a94f0f8f2f5c0a7b3e9d11';

function request(token?: string): Request {
  return new Request('http://localhost/api/setup', {
    method: 'POST',
    headers: token === undefined ? {} : { 'x-setup-token': token },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('without a configured token', () => {
  it('lets every request through, header or not', () => {
    vi.stubEnv('SETUP_TOKEN', '');
    expect(setupTokenRefusal(request())).toBeNull();
    expect(setupTokenRefusal(request('whatever'))).toBeNull();
  });

  it('treats a whitespace-only value as unset', () => {
    vi.stubEnv('SETUP_TOKEN', '   ');
    expect(setupTokenRefusal(request())).toBeNull();
  });
});

describe('with a configured token', () => {
  it('refuses a missing token with an opaque 403', async () => {
    vi.stubEnv('SETUP_TOKEN', TOKEN);
    const refusal = setupTokenRefusal(request());
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toEqual({ ok: false, error: 'Setup is not available.' });
  });

  it('refuses a wrong token of any length exactly as it refuses a missing one', async () => {
    vi.stubEnv('SETUP_TOKEN', TOKEN);
    const missing = await setupTokenRefusal(request())?.json();
    for (const wrong of ['', 'x', `${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
      const refusal = setupTokenRefusal(request(wrong));
      expect(refusal?.status).toBe(403);
      expect(await refusal?.json()).toEqual(missing);
    }
  });

  it('accepts the configured token, ignoring whitespace on either side', () => {
    vi.stubEnv('SETUP_TOKEN', `  ${TOKEN}  `);
    expect(setupTokenRefusal(request(TOKEN))).toBeNull();
    expect(setupTokenRefusal(request(` ${TOKEN} `))).toBeNull();
  });
});

describe('unclaimed-instance boot warning', () => {
  it('warns only while the instance is claimable and ungated', () => {
    vi.stubEnv('SETUP_TOKEN', '');
    expect(unclaimedSetupWarning(false)).toContain('SETUP_TOKEN');
    expect(unclaimedSetupWarning(true)).toBeNull();

    vi.stubEnv('SETUP_TOKEN', TOKEN);
    expect(unclaimedSetupWarning(false)).toBeNull();
  });
});
