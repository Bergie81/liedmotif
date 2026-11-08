// Account email: the one place the app sends mail (the `@liedmotif/providers/email`
// subpath, kept off the package root so the SMTP client never enters a graph that
// does not send mail). Server-only — the SMTP adapter opens sockets, and its
// config carries the mail account's password.

/** One plain-text mail to one recipient. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  /** Resolves once the mail server accepted the mail; throws `EmailSendError`. */
  send(message: EmailMessage): Promise<void>;
}

export { EmailSendError } from '../errors';
export { smtpEmailSender, type SmtpEmailConfig } from './smtp';
