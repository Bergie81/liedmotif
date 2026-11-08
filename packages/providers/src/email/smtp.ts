// SMTP adapter for account email, on nodemailer. Sends one mail per connection:
// account mail is a handful a day, so a pool would only hold sockets open.

import { createTransport } from 'nodemailer';
import { EmailSendError } from '../errors';
import type { EmailSender } from './index';

export interface SmtpEmailConfig {
  /**
   * Connection URL with credentials: `smtps://user:pass@host:465` (TLS from the
   * first byte) or `smtp://host:587` (STARTTLS when the server offers it).
   */
  url: string;
  /** The sender every mail carries, e.g. `Liedmotif <you@example.com>`. */
  from: string;
}

// Signed-in actions send inside the request, so an unreachable mail server must
// fail within a request's patience rather than nodemailer's minutes-long defaults.
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/** Nodemailer's codes are fixed identifiers; anything else is not passed on. */
const SAFE_ERROR_CODE = /^E[A-Z_]+$/;

export function smtpEmailSender({ url, from }: SmtpEmailConfig): EmailSender {
  return {
    async send({ to, subject, text }) {
      try {
        // Built inside the boundary: a URL nodemailer cannot parse throws with
        // the whole URL, password included, attached.
        const transport = createTransport({
          url,
          connectionTimeout: CONNECTION_TIMEOUT_MS,
          greetingTimeout: GREETING_TIMEOUT_MS,
          socketTimeout: SOCKET_TIMEOUT_MS,
        });
        await transport.sendMail({ from, to, subject, text });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        throw new EmailSendError(
          typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'EUNKNOWN',
        );
      }
    },
  };
}
