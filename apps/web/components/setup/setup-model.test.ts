import { describe, expect, it } from 'vitest';
import {
  buildSetupPayload,
  EMPTY_SETUP_STATE,
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
