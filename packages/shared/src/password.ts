// The one password policy for every surface that sets a password: invite claim,
// password reset, first-run setup, and the CLI admin recovery. Forms render
// `PASSWORD_RULES` as a live checklist; routes enforce via `passwordSchema`.

import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export interface PasswordRule {
  id: 'length' | 'number' | 'uppercase' | 'special';
  /** Checklist label; also the fragment the refusal message is composed from. */
  label: string;
  met: (password: string) => boolean;
}

export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: 'length',
    label: `at least ${MIN_PASSWORD_LENGTH} characters`,
    met: (password) => password.length >= MIN_PASSWORD_LENGTH,
  },
  { id: 'number', label: 'a number', met: (password) => /[0-9]/.test(password) },
  { id: 'uppercase', label: 'an uppercase letter', met: (password) => /[A-Z]/.test(password) },
  {
    id: 'special',
    label: 'a special character',
    met: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

/** The user-facing refusal naming every unmet rule, or `null` when compliant. */
export function validatePassword(password: string): string | null {
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  const unmet = PASSWORD_RULES.filter((rule) => !rule.met(password));
  if (unmet.length === 0) return null;
  return `Password needs ${unmet.map((rule) => rule.label).join(', ')}.`;
}

export const passwordSchema = z.string().superRefine((password, ctx) => {
  const message = validatePassword(password);
  if (message) ctx.addIssue({ code: 'custom', message });
});
