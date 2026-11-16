// First-run setup: the single screen that creates the admin account.
//
// It asks for the login and nothing else — a provider key or a spend ceiling typed
// here would only be asked again by first-login onboarding, which owns both. On
// success the admin is signed in and the app diverts to `/welcome`.

'use client';

import { useState, type FormEvent } from 'react';
import { MAX_EMAIL_LENGTH } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { SETUP_TOKEN_HEADER } from '@/lib/constants';
import {
  AlertBanner,
  cardClass,
  displayHeadingClass,
  LiedmotifMark,
  LiedmotifWordmark,
} from '@/components/ui/design-system';
import { inputClass, labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { PasswordField, usePasswordConfirmation } from '@/components/ui/password-field';
import { PasswordRequirements } from '@/components/ui/password-requirements';
import {
  buildSetupPayload,
  EMPTY_SETUP_STATE,
  validateSetup,
  type SetupState,
} from './setup-model';

export function SetupForm({ setupToken }: { setupToken?: string }) {
  const [form, setForm] = useState<SetupState>(EMPTY_SETUP_STATE);
  const confirmation = usePasswordConfirmation(form.password);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(patch: Partial<SetupState>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const matches = confirmation.check();
    const message = validateSetup(form);
    setError(message);
    if (message || !matches) return;
    setSubmitting(true);
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Only on a token-gated instance; the route accepts the request
          // without it everywhere else.
          ...(setupToken ? { [SETUP_TOKEN_HEADER]: setupToken } : {}),
        },
        body: JSON.stringify(buildSetupPayload(form)),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.ok && data.ok) {
        window.location.assign('/');
        return;
      }
      setError(data.error ?? 'Setup failed. Review your details and try again.');
    } catch {
      setError('Could not reach the server. Try again.');
    }
    setSubmitting(false);
  }

  return (
    <main className="mx-auto w-full max-w-[460px] px-4 py-10 desk:px-10">
      <div className="mb-9 flex items-center gap-3">
        <LiedmotifMark className="h-8 w-8" />
        <LiedmotifWordmark className="text-[22px]" />
      </div>

      <form onSubmit={submit}>
        <h1 id="setup-heading" className={displayHeadingClass}>
          Create your admin login
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Your private listening space starts with one Admin. Everything else — your profile, the
          music model and what it may spend — is set up the first time you sign in.
        </p>

        <section aria-labelledby="setup-heading" className={cn(cardClass, 'mt-6')}>
          <div className="flex flex-col gap-4">
            <label className={labelClass}>
              Email
              <input
                type="email"
                maxLength={MAX_EMAIL_LENGTH}
                autoComplete="username"
                value={form.email}
                onChange={(event) => update({ email: event.target.value })}
                className={inputClass}
                placeholder="admin@example.com"
              />
            </label>
            <PasswordField
              label="Password"
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => update({ password: event.target.value })}
              placeholder="Pick a strong password"
            />
            <PasswordRequirements password={form.password} />
            <PasswordField
              label="Confirm password"
              autoComplete="new-password"
              placeholder="Re-enter password"
              {...confirmation.field}
            />
          </div>
        </section>

        {error ? <AlertBanner className="mt-4">{error}</AlertBanner> : null}

        <button
          type="submit"
          disabled={submitting}
          className={cn(primaryButtonClass, 'mt-6 w-full')}
        >
          {submitting ? <LiedmotifLoader /> : null}
          {submitting ? 'Creating…' : 'Create admin'}
        </button>
      </form>
    </main>
  );
}
