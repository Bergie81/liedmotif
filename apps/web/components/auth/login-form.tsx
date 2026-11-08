'use client';

// Admin login. Talks to Better Auth's email sign-in endpoint with plain fetch; on
// success Better Auth sets the session cookie and we hard-navigate into the app.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { AlertBanner } from '@/components/ui/design-system';
import { inputClass, labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { PasswordField } from '@/components/ui/password-field';
import { signInErrorMessage } from '@/lib/sign-in-error';

/** `canResetByEmail`: account email is on, so "Forgot password?" leads somewhere. */
export function LoginForm({ canResetByEmail }: { canResetByEmail: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.assign('/');
        return;
      }
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      setError(
        signInErrorMessage(res.status, typeof body?.code === 'string' ? body.code : undefined),
      );
    } catch {
      setError('Could not reach the server. Try again.');
    }
    setBusy(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className={labelClass}>
        Email
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
          placeholder="admin@example.com"
        />
      </label>
      <PasswordField
        label="Password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="••••••••"
      />

      {error ? <AlertBanner>{error}</AlertBanner> : null}

      <button type="submit" disabled={busy} className={cn(primaryButtonClass, 'mt-1 w-full')}>
        {busy ? <LiedmotifLoader /> : null}
        {busy ? 'Signing in…' : 'Sign in'}
      </button>

      {canResetByEmail ? (
        <Link
          href="/forgot"
          className="self-center text-[13.5px] font-semibold text-lamp underline-offset-4 hover:underline"
        >
          Forgot password?
        </Link>
      ) : null}
    </form>
  );
}
