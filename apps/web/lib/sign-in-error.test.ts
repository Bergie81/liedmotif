import { describe, expect, it } from 'vitest';
import {
  SIGN_IN_FAILED_MESSAGE,
  SIGN_IN_RATE_LIMITED_MESSAGE,
  signInErrorMessage,
  WRONG_ADDRESS_MESSAGE,
  WRONG_CREDENTIALS_MESSAGE,
} from './sign-in-error';

describe('signInErrorMessage', () => {
  it('calls only a credential refusal a wrong password', () => {
    expect(signInErrorMessage(401, 'INVALID_EMAIL_OR_PASSWORD')).toBe(WRONG_CREDENTIALS_MESSAGE);
    expect(signInErrorMessage(401, undefined)).toBe(WRONG_CREDENTIALS_MESSAGE);
    expect(signInErrorMessage(400, 'INVALID_EMAIL')).toBe(WRONG_CREDENTIALS_MESSAGE);
  });

  it('sends a browser on an untrusted address to the configured one', () => {
    expect(signInErrorMessage(403, 'INVALID_ORIGIN')).toBe(WRONG_ADDRESS_MESSAGE);
    expect(signInErrorMessage(403, 'MISSING_OR_NULL_ORIGIN')).toBe(WRONG_ADDRESS_MESSAGE);
  });

  it('words the sign-in throttle as a wait', () => {
    expect(signInErrorMessage(429, undefined)).toBe(SIGN_IN_RATE_LIMITED_MESSAGE);
  });

  it('never blames the password for an unexpected refusal', () => {
    for (const [status, code] of [
      [403, undefined],
      [403, 'EMAIL_NOT_VERIFIED'],
      [404, undefined],
      [500, undefined],
      [502, undefined],
    ] as const) {
      expect(signInErrorMessage(status, code)).toBe(SIGN_IN_FAILED_MESSAGE);
    }
  });
});
