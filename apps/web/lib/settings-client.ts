// Browser-side writes to the settings routes, shared by Settings' own forms and
// the first-login onboarding steps so both surfaces send the same body to the same
// endpoint and read failures the same way.
//
// Every call resolves rather than throws, because each caller renders the failure
// inline next to the control that caused it.

import type { ListenerProfile, UsageLimits } from '@liedmotif/db';
import type { PersonSummary } from './people';

export type SettingsWrite<T> = { ok: true; value: T } | { ok: false; error: string };

async function postJson<T>(
  path: string,
  body: unknown,
  fallbackMessage: string,
  read: (payload: Record<string, unknown>) => T | undefined,
): Promise<SettingsWrite<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  const payload = response
    ? ((await response.json().catch(() => ({}))) as Record<string, unknown>)
    : {};
  if (response?.ok && payload.ok === true) {
    const value = read(payload);
    if (value !== undefined) return { ok: true, value };
  }
  return {
    ok: false,
    error: typeof payload.error === 'string' ? payload.error : fallbackMessage,
  };
}

/**
 * Save the whole listener profile; the route echoes back what it stored.
 * `currentPassword` is the re-confirmation the route demands when the save moves
 * the login email — it is never stored, so it rides alongside the profile rather
 * than inside it.
 */
export function saveListenerProfile(
  profile: ListenerProfile,
  currentPassword?: string,
): Promise<SettingsWrite<SavedListenerProfile>> {
  return postJson(
    '/api/settings/profile',
    currentPassword ? { ...profile, currentPassword } : profile,
    'Could not save profile.',
    (payload) => {
      const saved = payload.profile as ListenerProfile | undefined;
      if (!saved) return undefined;
      return typeof payload.confirmLinkSent === 'boolean'
        ? { profile: saved, confirmLinkSent: payload.confirmLinkSent }
        : { profile: saved };
    },
  );
}

export interface SavedListenerProfile {
  profile: ListenerProfile;
  /**
   * Present only when the save moved the sign-in address while account email is
   * on: whether the confirm link for the new address went out.
   */
  confirmLinkSent?: boolean;
}

/**
 * The People roster as the server now holds it — names and About only, no photos.
 * Used to pick up a change the server made on its own (the owner Person following a
 * User-name change), which the client has no other way to learn about.
 */
export async function loadPeopleNames(): Promise<PersonSummary[] | null> {
  const response = await fetch('/api/settings/people').catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { people?: PersonSummary[] };
  return body.people ?? null;
}

/**
 * The image provider that can use the Text AI's key as stored now, or `null`;
 * `undefined` when it could not be read.
 */
export async function readSharedKeyVendor(): Promise<string | null | undefined> {
  const response = await fetch('/api/settings/credentials').catch(() => null);
  if (!response?.ok) return undefined;
  const body = (await response.json().catch(() => ({}))) as { sharedKeyVendor?: unknown };
  if (body.sharedKeyVendor === null || typeof body.sharedKeyVendor === 'string') {
    return body.sharedKeyVendor;
  }
  return undefined;
}

/** Apply a partial cost-limits patch; omitted fields keep their stored value. */
export function saveUsageLimits(patch: Partial<UsageLimits>): Promise<SettingsWrite<UsageLimits>> {
  return postJson(
    '/api/settings/limits',
    patch,
    'Could not save limits.',
    (payload) => payload.limits as UsageLimits | undefined,
  );
}
