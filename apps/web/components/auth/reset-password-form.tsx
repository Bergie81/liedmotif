'use client';

// One password, typed twice, one shot: spend the reset link, then hand over to
// sign-in.

import { useState, type FormEvent } from 'react';
import { MIN_PASSWORD_LENGTH, validatePassword } from '@liedmotif/shared';
import { apiFetchJson } from '@/lib/http/api-fetch';
import { cn } from '@/lib/cn';
import { AlertBanner } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { PasswordField, usePasswordConfirmation } from '@/components/ui/password-field';
import { PasswordRequirements } from '@/components/ui/password-requirements';

export function ResetPasswordForm({ token }: { token: string }) {
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
    const result = await apiFetchJson('/api/join/reset', 'POST', { token, password });
    if (result.ok) {
      window.location.assign('/login');
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
      <PasswordField
        label="New password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
      />
      <PasswordRequirements password={password} />
      <PasswordField
        label="Confirm new password"
        autoComplete="new-password"
        required
        placeholder="Re-enter password"
        {...confirmation.field}
      />

      {error ? <AlertBanner>{error}</AlertBanner> : null}

      <button type="submit" disabled={busy} className={cn(primaryButtonClass, 'mt-1 w-full')}>
        {busy ? <LiedmotifLoader /> : null}
        {busy ? 'Setting password…' : 'Set password and sign in'}
      </button>
    </form>
  );
}
