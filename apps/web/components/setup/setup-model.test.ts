import { describe, expect, it } from 'vitest';
import {
  buildSetupPayload,
  EMPTY_SETUP_STATE,
  setupAddressNotice,
  validateSetup,
  type SetupState,
} from './setup-model';

function form(overrides: Partial<SetupState> = {}): SetupState {
  return {
    ...EMPTY_SETUP_STATE,
    email: 'admin@example.test',
    password: 'Correct-Horse-42',
    ...overrides,
  };
}

describe('setup model', () => {
  it('accepts a complete admin login', () => {
    expect(validateSetup(form())).toBeNull();
  });

  it('rejects an address that is not an email', () => {
    expect(validateSetup(form({ email: 'admin' }))).toBe('Enter a valid email address.');
  });

  it('rejects a weak password with the message naming every unmet rule', () => {
    const message = validateSetup(form({ password: 'shortpw' }));
    expect(message).toMatch(/12 characters/);
    expect(message).toMatch(/number/i);
    expect(message).toMatch(/uppercase/i);
    expect(message).toMatch(/special/i);
  });

  it('submits the admin login alone', () => {
    // Provider keys and cost limits belong to first-login onboarding, which asks for
    // them once — this screen only creates the account that can sign in and answer.
    expect(buildSetupPayload(form({ email: '  admin@example.test  ' }))).toEqual({
      admin: { email: 'admin@example.test', password: 'Correct-Horse-42' },
    });
  });
});

describe('setup address notice', () => {
  const PUBLIC_URL = 'http://localhost:2206';

  it('names the configured address when the page was opened at another host', () => {
    expect(setupAddressNotice('127.0.0.1:2206', PUBLIC_URL)).toBe(
      'This install is set up for http://localhost:2206. Open it there, or set APP_PUBLIC_URL to this address and restart.',
    );
  });

  it('shows nothing at the configured host, whatever the scheme or case', () => {
    expect(setupAddressNotice('localhost:2206', PUBLIC_URL)).toBeNull();
    expect(setupAddressNotice('Music.Example', 'https://music.example/')).toBeNull();
  });

  it('treats a different port as a different host', () => {
    expect(setupAddressNotice('localhost:3000', PUBLIC_URL)).not.toBeNull();
  });

  it('shows nothing when the request carries no host to compare', () => {
    expect(setupAddressNotice(null, PUBLIC_URL)).toBeNull();
  });
});
