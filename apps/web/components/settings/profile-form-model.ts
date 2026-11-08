import type { ListenerProfile } from '@liedmotif/db';

/**
 * `currentPassword` is not part of the stored profile — it is the confirmation
 * the server demands before it will move the login email — but its refusal has
 * to render on its own field like every other one.
 */
export type ProfileFieldErrors = Partial<Record<keyof ListenerProfile | 'currentPassword', string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateProfile(values: ListenerProfile): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};
  if (!values.name.trim()) errors.name = 'Enter a name.';
  if (!EMAIL_PATTERN.test(values.email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  return errors;
}

export function profileFieldErrorsForServerMessage(message: string): ProfileFieldErrors {
  const normalized = message.toLowerCase();
  if (normalized.includes('password')) return { currentPassword: message };
  if (normalized.includes('description')) return { description: message };
  if (normalized.includes('city') && normalized.includes('country')) {
    return { city: message, country: message };
  }
  if (normalized.includes('email')) return { email: message };
  if (normalized.includes('artist name')) return { artistName: message };
  if (normalized.includes('city')) return { city: message };
  if (normalized.includes('country')) return { country: message };
  if (normalized.includes('name')) return { name: message };
  return {};
}
