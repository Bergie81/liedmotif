// Input validation for the first-run setup payload. Lightweight and dependency-free
// (no Zod). Every failure throws a `SetupValidationError` with a safe, user-facing
// message.

import { validatePassword } from '@liedmotif/shared';

export class SetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupValidationError';
  }
}

/**
 * Install-time input: the account that can sign in, and nothing else. Provider keys
 * and cost limits are asked on first login (`/welcome`), the instance's public URL
 * comes from `APP_PUBLIC_URL`, and its reset timezone from the shipped defaults — so
 * anything else in the body is not configuration this route accepts.
 */
export interface SetupPayload {
  admin: { email: string; password: string };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new SetupValidationError(`Missing or invalid ${field}.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SetupValidationError(`${field} is required.`);
  }
  return value.trim();
}

/** Parse and validate the setup payload, throwing `SetupValidationError` on bad input. */
export function parseSetupPayload(body: unknown): SetupPayload {
  const root = asRecord(body, 'request body');

  const adminRaw = asRecord(root.admin, 'admin');
  const email = asString(adminRaw.email, 'Admin email');
  if (!email.includes('@')) throw new SetupValidationError('Enter a valid email address.');
  const password = typeof adminRaw.password === 'string' ? adminRaw.password : '';
  const passwordError = validatePassword(password);
  if (passwordError) throw new SetupValidationError(passwordError);

  return { admin: { email, password } };
}
