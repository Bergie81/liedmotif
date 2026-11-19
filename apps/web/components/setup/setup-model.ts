// The pure shape of first-run setup: the one login it collects and what it submits.
//
// Install-time asks for what must exist before anyone can sign in, and no more. The
// owner's own details, the People, the provider keys and every spend ceiling are
// asked on first login (`/welcome`), where the owner is present to answer them.

import { validatePassword } from '@liedmotif/shared';
import type { SetupPayload } from '@/lib/auth/setup-validation';

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

/**
 * The notice the setup screen shows above the form when it was opened at a host
 * other than the one `APP_PUBLIC_URL` names, or `null` when they match. Setup
 * accepts a post only from that host, so the form would fail on submit; this
 * says so before anything is typed. Hosts are compared without the scheme, as
 * the route does, because TLS terminates at the proxy.
 */
export function setupAddressNotice(requestHost: string | null, publicUrl: string): string | null {
  const opened = requestHost === null ? null : hostOf(`http://${requestHost}`);
  const configured = hostOf(publicUrl);
  if (opened === null || configured === null || opened === configured) return null;
  return `This install is set up for ${publicUrl}. Open it there, or set APP_PUBLIC_URL to this address and restart.`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
