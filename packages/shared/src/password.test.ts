import { describe, expect, it } from 'vitest';
import { PASSWORD_RULES, passwordSchema, validatePassword } from './password';

describe('validatePassword', () => {
  it('accepts a password meeting every rule', () => {
    expect(validatePassword('Correct-Horse-42')).toBeNull();
  });

  it('rejects a password shorter than 12 characters', () => {
    expect(validatePassword('Sh0rt-pw!')).toMatch(/12/);
  });

  it('rejects a password without a number', () => {
    expect(validatePassword('Correct-Horse-Battery')).toMatch(/number/i);
  });

  it('rejects a password without an uppercase letter', () => {
    expect(validatePassword('correct-horse-42')).toMatch(/uppercase/i);
  });

  it('rejects a password without a special character', () => {
    expect(validatePassword('CorrectHorse42')).toMatch(/special/i);
  });

  it('names every unmet rule in one message', () => {
    const message = validatePassword('short');
    expect(message).toMatch(/12/);
    expect(message).toMatch(/number/i);
    expect(message).toMatch(/uppercase/i);
    expect(message).toMatch(/special/i);
  });

  it('rejects a password over 128 characters', () => {
    expect(validatePassword(`Aa1!${'x'.repeat(130)}`)).toMatch(/128/);
  });
});

describe('PASSWORD_RULES', () => {
  it('exposes the four rules with per-password met state for checklist UIs', () => {
    const met = PASSWORD_RULES.map((rule) => rule.met('correct-horse-42'));
    // 12+ chars: yes; number: yes; uppercase: no; special: yes.
    expect(met).toEqual([true, true, false, true]);
  });
});

describe('passwordSchema', () => {
  it('accepts a compliant password', () => {
    expect(passwordSchema.safeParse('Correct-Horse-42').success).toBe(true);
  });

  it('rejects a weak password with the policy message', () => {
    const parsed = passwordSchema.safeParse('correcthorse');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/number/i);
    }
  });
});
