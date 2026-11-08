import { describe, expect, it } from 'vitest';
import { parseSetupPayload, SetupValidationError } from './setup-validation';

// Install-time input is the admin login and nothing else. Provider keys and cost
// limits are asked on first login, where the owner is present to answer them, so a
// body carrying them must not be able to configure the instance through this route.

// Meets every PASSWORD_RULES entry (length, number, uppercase, special).
const VALID_PASSWORD = 'Correct-horse-42';

function admin(overrides: Record<string, unknown> = {}) {
  return { admin: { email: 'admin@example.test', password: VALID_PASSWORD, ...overrides } };
}

describe('parseSetupPayload', () => {
  it('parses the admin login and trims the email', () => {
    expect(parseSetupPayload(admin({ email: '  admin@example.test  ' }))).toEqual({
      admin: { email: 'admin@example.test', password: VALID_PASSWORD },
    });
  });

  it('ignores provider and limit configuration a client might still send', () => {
    const parsed = parseSetupPayload({
      ...admin(),
      music: { mode: 'key', apiKey: 'suno-secret' },
      llm: { providerKey: 'openai', apiKey: 'sk-oai-1' },
      limits: { dailyGenerationTasks: 9999 },
    });

    expect(Object.keys(parsed)).toEqual(['admin']);
  });

  it('rejects a body with no admin login', () => {
    expect(() => parseSetupPayload({})).toThrow(SetupValidationError);
    expect(() => parseSetupPayload({})).toThrow(/admin/i);
  });

  it('rejects an address that is not an email', () => {
    expect(() => parseSetupPayload(admin({ email: 'admin' }))).toThrow(/valid email/i);
  });

  it('rejects a password that fails the shared policy, naming the unmet rules', () => {
    // The route delegates to the one shared policy (packages/shared/src/password.ts);
    // 'short' misses every rule, so the refusal names them all.
    expect(() => parseSetupPayload(admin({ password: 'short' }))).toThrow(
      /at least 12 characters, a number, an uppercase letter, a special character/i,
    );
  });
});
