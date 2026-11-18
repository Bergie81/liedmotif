'use client';

// Settings → Profile's one way to change the signed-in User's own password.
// With account email on it mails the 1-hour reset link "Forgot password?" sends,
// and only to a Confirmed email; with it off it is the current + new password
// form. The dialog's content unmounts on close, so every open starts fresh.

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { MIN_PASSWORD_LENGTH, validatePassword } from '@liedmotif/shared';
import {
  Dialog,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { PasswordField, usePasswordConfirmation } from '@/components/ui/password-field';
import { PasswordRequirements } from '@/components/ui/password-requirements';
import { apiFetchJson } from '@/lib/api-fetch';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { requestConfirmLink } from './email-confirmation';
import { SettingsFeedback } from './settings-ui';

const bodyClass = 'mt-2 text-[13.5px] leading-relaxed text-muted';

/** One key for the dialog: whichever step failed, a retry replaces or clears it. */
const FAILURE_KEY = 'change-password';

function reportFailure(message: string) {
  toast.error(message, { key: FAILURE_KEY });
}

export function ChangePasswordButton({
  email,
  emailConfirmed,
}: {
  /** The saved sign-in address — the one a mail goes to, never an unsaved edit. */
  email: string;
  /** Whether that address is a Confirmed email; null while account email is off. */
  emailConfirmed: boolean | null;
}) {
  const router = useRouter();
  return (
    // The confirm link opens in another tab, so each open re-reads whether the
    // address is confirmed now.
    <Dialog onOpenChange={(open) => open && router.refresh()}>
      <DialogTrigger className={secondaryButtonClass}>
        <KeyRound className="h-4 w-4" aria-hidden />
        Change password
      </DialogTrigger>
      <DialogContent data-testid="change-password-dialog">
        <DialogCloseButton />
        <DialogTitle className="pr-8 font-display text-[18px] font-bold tracking-[-0.01em]">
          Change password
        </DialogTitle>
        <ChangePasswordStep email={email} emailConfirmed={emailConfirmed} />
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordStep({
  email,
  emailConfirmed,
}: {
  email: string;
  emailConfirmed: boolean | null;
}) {
  if (emailConfirmed === null) return <CurrentPasswordChange />;
  if (emailConfirmed) return <ResetLinkRequest email={email} />;
  return <ConfirmEmailFirst email={email} />;
}

function resetLinkErrorMessage(status: number, serverMessage: string): string {
  switch (status) {
    case 409:
      return 'Confirm your email first with Send confirm link next to your email.';
    case 429:
      return 'Too many reset links. Wait a few minutes, then try again.';
    default:
      return serverMessage;
  }
}

function ResetLinkRequest({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function send() {
    setSending(true);
    toast.dismiss(FAILURE_KEY);
    const result = await apiFetchJson<{ sentTo: string }>(
      '/api/settings/profile/reset-link',
      'POST',
      {},
    );
    setSending(false);
    if (!result.ok) {
      reportFailure(resetLinkErrorMessage(result.status, result.message));
      return;
    }
    setSentTo(result.data.sentTo);
  }

  if (sentTo) return <Done>Sent to {sentTo}. The link works for 1 hour.</Done>;
  return (
    <>
      <DialogDescription className={bodyClass}>
        A link to set a new password goes to <Address>{email}</Address>. It works for 1 hour, and
        using it signs you out everywhere.
      </DialogDescription>
      <button
        type="button"
        onClick={send}
        disabled={sending}
        className={cn(primaryButtonClass, 'mt-6 w-full')}
      >
        {sending ? 'Sending…' : 'Send link'}
      </button>
    </>
  );
}

function ConfirmEmailFirst({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  async function send() {
    setSending(true);
    toast.dismiss(FAILURE_KEY);
    const result = await requestConfirmLink();
    setSending(false);
    if (!result.sent) {
      reportFailure(result.message);
      return;
    }
    setSent(result.message);
  }

  if (sent) return <Done>{sent}</Done>;
  return (
    <>
      <DialogDescription className={bodyClass}>
        Confirm your email first: a password link only goes to a confirmed address. Send a confirm
        link to <Address>{email}</Address>, open it, then come back here.
      </DialogDescription>
      <button
        type="button"
        onClick={send}
        disabled={sending}
        className={cn(primaryButtonClass, 'mt-6 w-full')}
      >
        {sending ? 'Sending…' : 'Send confirm link'}
      </button>
    </>
  );
}

function CurrentPasswordChange() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const confirmation = usePasswordConfirmation(newPassword);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const matches = confirmation.check();
    const broken = validatePassword(newPassword);
    setPasswordError(broken);
    if (broken || !matches) return;
    setBusy(true);
    toast.dismiss(FAILURE_KEY);
    const result = await apiFetchJson('/api/settings/profile/password', 'POST', {
      currentPassword,
      newPassword,
    });
    setBusy(false);
    if (result.ok) {
      setChanged(true);
      return;
    }
    reportFailure(
      result.status === 429
        ? 'Too many attempts. Wait a few minutes, then try again.'
        : result.message,
    );
  }

  if (changed) return <Done>Password changed. Every other browser is signed out.</Done>;
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
      <PasswordField
        label="Current password"
        autoComplete="current-password"
        required
        value={currentPassword}
        disabled={busy}
        onChange={(event) => setCurrentPassword(event.target.value)}
      />
      <PasswordField
        label="New password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        value={newPassword}
        disabled={busy}
        {...(passwordError ? { error: passwordError } : {})}
        onChange={(event) => {
          setNewPassword(event.target.value);
          setPasswordError(null);
        }}
      />
      <PasswordRequirements password={newPassword} />
      <PasswordField
        label="Confirm new password"
        autoComplete="new-password"
        required
        disabled={busy}
        {...confirmation.field}
      />
      <button type="submit" disabled={busy} className={cn(primaryButtonClass, 'mt-2 w-full')}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}

function Address({ children }: { children: string }) {
  return <span className="break-words text-paper">{children}</span>;
}

function Done({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="mt-4">
        <SettingsFeedback kind="success">{children}</SettingsFeedback>
      </div>
      <DialogClose className={cn(primaryButtonClass, 'mt-6 w-full')}>Done</DialogClose>
    </>
  );
}
