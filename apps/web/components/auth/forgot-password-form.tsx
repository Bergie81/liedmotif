'use client';

// One field: ask for a reset link. The server answers every address the same
// way, so the form does too — it never learns, and never says, whether a mail
// went out.

import { useState, type FormEvent } from 'react';
import { CircleCheck } from 'lucide-react';
import { MAX_EMAIL_LENGTH } from '@liedmotif/shared';
import { apiFetchJson } from '@/lib/http/api-fetch';
import { cn } from '@/lib/cn';
import { AlertBanner } from '@/components/ui/design-system';
import { inputClass, labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiFetchJson('/api/join/forgot', 'POST', { email });
    setBusy(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    setError(
      result.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : result.message,
    );
  }

  if (sent) {
    return (
      <p role="status" className="flex items-start gap-2 text-[14px] leading-relaxed text-signal">
        <CircleCheck className="mt-1 h-4 w-4 shrink-0" aria-hidden />
        If that address belongs to an account with a confirmed email, we sent a link. It works for 1
        hour.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className={labelClass}>
        Email
        <input
          type="email"
          maxLength={MAX_EMAIL_LENGTH}
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
          placeholder="you@example.com"
        />
      </label>

      {error ? <AlertBanner>{error}</AlertBanner> : null}

      <button type="submit" disabled={busy} className={cn(primaryButtonClass, 'mt-1 w-full')}>
        {busy ? <LiedmotifLoader /> : null}
        {busy ? 'Sending…' : 'Email Me a Reset Link'}
      </button>
    </form>
  );
}
