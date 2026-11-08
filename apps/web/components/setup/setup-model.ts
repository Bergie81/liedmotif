// The pure shape of first-run setup: the one login it collects and what it submits.
//
// Install-time asks for what must exist before anyone can sign in, and no more. The
// owner's own details, the People, the provider keys and every spend ceiling are
// asked on first login (`/welcome`), where the owner is present to answer them.

import { validatePassword } from '@liedmotif/shared';
import type { SetupPayload } from '@/lib/setup-validation';

export interface SetupState {
  email: string;
  password: string;
}

export const EMPTY_SETUP_STATE: SetupState = { email: '', password: '' };

/**
 * The first thing wrong with the login, or `null` when it can be submitted. The
 * repeated password is checked beside its own field.
 */
export function validateSetup(form: SetupState): string | null {
  if (!form.email.includes('@')) return 'Enter a valid email address.';
  return validatePassword(form.password);
}

export function buildSetupPayload(form: SetupState): SetupPayload {
  return { admin: { email: form.email.trim(), password: form.password } };
}
