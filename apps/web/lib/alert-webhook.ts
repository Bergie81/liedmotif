// The Instance alerts webhook: one generic JSON POST, the counterpart of
// `mailInstanceAlert` in `account-mail.ts`. Server-only.
//
// The URL gets no egress guard on purpose: it comes from the Admin's
// `.env`, never from a request, and a receiver on loopback or the LAN is the
// intended target. It may carry the receiver's own token, so a failure logs the
// condition and outcome only and never the thrown error, which can quote the URL.

import { createLogger } from '@liedmotif/shared';
import type { InstanceAlertNotification } from './instance-alerts-model';

const log = createLogger({ name: 'alert-webhook' });

const WEBHOOK_TIMEOUT_MS = 5_000;

/** ntfy's publish protocol; inert on every other receiver. */
function webhookPriority({ state, severity }: InstanceAlertNotification): string {
  if (state === 'recovered') return 'default';
  return severity === 'critical' ? 'urgent' : 'high';
}

/**
 * POST one Instance alert. False when the receiver refused it or could not be
 * reached. The message sits under `message`, `text`, and `content` because Gotify,
 * Slack, and Discord each read a different one and ignore the rest.
 */
export async function postAlertWebhook(
  url: string,
  notification: InstanceAlertNotification,
  instance: string,
): Promise<boolean> {
  const { condition, title, message } = notification;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Title: title,
        Priority: webhookPriority(notification),
      },
      body: JSON.stringify({ ...notification, instance, text: message, content: message }),
      // A followed 301/302 would turn the POST into a bodyless GET and read as delivered.
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return true;
    log.warn('alert webhook refused the notification', { condition, status: response.status });
    return false;
  } catch {
    log.warn('alert webhook could not be reached', { condition });
    return false;
  }
}
