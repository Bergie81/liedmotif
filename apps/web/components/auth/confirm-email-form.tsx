'use client';

// One button, one shot: spend the confirm link. A button rather than the page
// load, because mail scanners open every link in a mail before its reader does.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { apiFetchJson } from '@/lib/http/api-fetch';
import { cn } from '@/lib/cn';
import { AlertBanner } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';

export function ConfirmEmailForm({ token }: { token: string }) {
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await apiFetchJson('/api/join/confirm', 'POST', { token });
    setBusy(false);
    if (result.ok) {
      setConfirmed(true);
      return;
    }
    setError(
      result.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : result.message,
    );
  }

  if (confirmed) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="flex items-start gap-2 text-[14px] text-signal">
          <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Your email is confirmed.
        </p>
        <Link
          href="/"
          className="text-[13.5px] font-semibold text-lamp underline-offset-4 hover:underline"
        >
          Open Liedmotif
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <AlertBanner>{error}</AlertBanner> : null}
      <button type="submit" disabled={busy} className={cn(primaryButtonClass, 'w-full')}>
        {busy ? <LiedmotifLoader /> : null}
        {busy ? 'Confirming…' : 'Confirm email'}
      </button>
    </form>
  );
}
