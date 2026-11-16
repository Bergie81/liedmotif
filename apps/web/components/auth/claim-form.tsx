'use client';

// The invite claim form: display name, email, password. An emailed Invite
// brings its address, shown read-only — the server takes the Invite's own and
// ignores what is sent. On success the Member is signed in server-side, so a
// hard navigation lands them in their welcome.

import { useState, type FormEvent } from 'react';
import {
  MAX_EMAIL_LENGTH,
  MAX_USER_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
} from '@liedmotif/shared';
import { apiFetchJson } from '@/lib/api-fetch';
import { cn } from '@/lib/cn';
import { AlertBanner } from '@/components/ui/design-system';
import { inputClass, labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { PasswordField, usePasswordConfirmation } from '@/components/ui/password-field';
import { PasswordRequirements } from '@/components/ui/password-requirements';

export function ClaimForm({
  token,
  invitedEmail,
}: {
  token: string;
  /** The address an emailed Invite was sent to; null for a copy-link Invite. */
  invitedEmail: string | null;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState(invitedEmail ?? '');
  const [password, setPassword] = useState('');
  const confirmation = usePasswordConfirmation(password);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const matches = confirmation.check();
    const passwordError = validatePassword(password);
    setError(passwordError);
    if (passwordError || !matches) return;
    setBusy(true);
    const result = await apiFetchJson<{ signedIn?: boolean }>('/api/join/claim', 'POST', {
      token,
      name,
      email,
      password,
    });
    if (result.ok) {
      // Signed in: the server-side guards route a fresh Member into their
      // welcome. If the automatic sign-in failed the account still exists,
      // so the login screen is the honest next stop.
      window.location.assign(result.data.signedIn === false ? '/login' : '/');
      return;
    }
    setError(
      result.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : result.message,
    );
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className={labelClass}>
        Your name
        <input
          type="text"
          autoComplete="name"
          required
          maxLength={MAX_USER_NAME_LENGTH}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder="How the player greets you"
        />
      </label>
      <label className={labelClass}>
        Email
        <input
          type="email"
          maxLength={MAX_EMAIL_LENGTH}
          autoComplete="username"
          required
          value={email}
          readOnly={invitedEmail !== null}
          onChange={(e) => setEmail(e.target.value)}
          className={cn(inputClass, invitedEmail !== null && 'text-muted')}
          placeholder="you@example.com"
        />
      </label>
      <PasswordField
        label="Password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
      />
      <PasswordRequirements password={password} />
      <PasswordField
        label="Confirm password"
        autoComplete="new-password"
        required
        placeholder="Re-enter password"
        {...confirmation.field}
      />

      {error ? <AlertBanner>{error}</AlertBanner> : null}

      <button type="submit" disabled={busy} className={cn(primaryButtonClass, 'mt-1 w-full')}>
        {busy ? <LiedmotifLoader /> : null}
        {busy ? 'Creating your account…' : 'Create my account'}
      </button>
    </form>
  );
}
