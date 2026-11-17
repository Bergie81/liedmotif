'use client';

// The sign-in address's Confirmed email state, with the way to confirm it.
// Rendered only while account email is on.

import { useState } from 'react';
import { apiFetchJson } from '@/lib/api-fetch';
import { SettingsStatusBadge, type SettingsFeedbackState } from './settings-ui';

/** Mails a confirm link to the saved sign-in address; resolves to what to tell the user. */
export async function requestConfirmLink(): Promise<{ sent: boolean; message: string }> {
  const result = await apiFetchJson('/api/settings/profile/confirm-link', 'POST', {});
  if (result.ok) return { sent: true, message: 'Confirm link sent. Open it within 24 hours.' };
  return {
    sent: false,
    message:
      result.status === 429
        ? 'Too many confirm links. Wait a few minutes, then try again.'
        : result.message,
  };
}

/** `requestConfirmLink` with its answer held as feedback, for a surface that shows it in place. */
export function useConfirmLinkRequest() {
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedbackState>(null);

  async function send() {
    setSending(true);
    setFeedback(null);
    const { sent, message } = await requestConfirmLink();
    setSending(false);
    setFeedback({ kind: sent ? 'success' : 'error', message });
  }

  return { sending, feedback, send };
}

/** On the Email label row: the badge, and the send action while unconfirmed. */
export function EmailConfirmationStatus({
  confirmed,
  sending,
  onSend,
}: {
  confirmed: boolean;
  sending: boolean;
  onSend: () => void;
}) {
  if (confirmed) return <SettingsStatusBadge status={{ label: 'Confirmed', tone: 'ok' }} />;
  return (
    <>
      <SettingsStatusBadge status={{ label: 'Not confirmed', tone: 'warn' }} />
      <span aria-hidden className="text-dim">
        ·
      </span>
      <button
        type="button"
        onClick={onSend}
        disabled={sending}
        className="text-[13px] font-semibold text-lamp underline-offset-4 hover:underline disabled:opacity-60"
      >
        {sending ? 'Sending…' : 'Send confirm link'}
      </button>
    </>
  );
}
