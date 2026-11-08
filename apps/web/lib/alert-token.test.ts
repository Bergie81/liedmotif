import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertTokenRefusal } from './alert-token';

// The inverse of `SETUP_TOKEN`'s policy: this endpoint triggers outbound
// messages, so an unset token means the feature is off, not that the door is open.

const TOKEN = 'a3f1c6d2e4b84a0f9e2f7c1d5b6a8e90';

function request(token?: string): Request {
  return new Request('http://localhost/api/alerts/check', {
    headers: token === undefined ? {} : { 'x-alert-token': token },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('without a configured token', () => {
  it('answers 404 for every request, header or not', () => {
    vi.stubEnv('ALERT_CHECK_TOKEN', '');
    expect(alertTokenRefusal(request())?.status).toBe(404);
    expect(alertTokenRefusal(request('whatever'))?.status).toBe(404);
  });

  it('treats a whitespace-only value as unset', () => {
    vi.stubEnv('ALERT_CHECK_TOKEN', '   ');
    expect(alertTokenRefusal(request('   '))?.status).toBe(404);
  });
});

describe('with a configured token', () => {
  it('refuses a wrong token of any length exactly as it refuses a missing one', async () => {
    vi.stubEnv('ALERT_CHECK_TOKEN', TOKEN);
    const missing = alertTokenRefusal(request());
    expect(missing?.status).toBe(403);
    const missingBody = await missing?.text();
    for (const wrong of ['', 'x', `${TOKEN}x`, TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
      const refusal = alertTokenRefusal(request(wrong));
      expect(refusal?.status).toBe(403);
      expect(await refusal?.text()).toBe(missingBody);
    }
  });

  it('never echoes the configured token', async () => {
    vi.stubEnv('ALERT_CHECK_TOKEN', TOKEN);
    expect(await alertTokenRefusal(request('wrong'))?.text()).not.toContain(TOKEN);
  });

  it('accepts the configured token, ignoring whitespace on either side', () => {
    vi.stubEnv('ALERT_CHECK_TOKEN', `  ${TOKEN}  `);
    expect(alertTokenRefusal(request(TOKEN))).toBeNull();
    expect(alertTokenRefusal(request(` ${TOKEN} `))).toBeNull();
  });
});
