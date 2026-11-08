import { describe, expect, it } from 'vitest';
import { resolveSetupState } from './state';

describe('resolveSetupState', () => {
  it('routes to setup when no admin exists yet', () => {
    expect(resolveSetupState({ adminExists: false, signedIn: false })).toBe('setup');
    // Even a stray cookie cannot reach the app before an admin exists.
    expect(resolveSetupState({ adminExists: false, signedIn: true })).toBe('setup');
  });

  it('routes to login when an admin exists but nobody is signed in', () => {
    expect(resolveSetupState({ adminExists: true, signedIn: false })).toBe('login');
  });

  it('routes to the app when an admin is signed in', () => {
    expect(resolveSetupState({ adminExists: true, signedIn: true })).toBe('app');
  });
});
