// Test-only surface of `@liedmotif/providers` (the `@liedmotif/providers/testing`
// subpath, mirroring `@liedmotif/db/testing`). Never imported by runtime code.

import type { EmailMessage, EmailSender } from './email/index';

/**
 * The sanitized Suno API fixtures, so OTHER packages' integration suites (the
 * worker poll/pipeline tests) can drive the real adapter through an injected
 * `fetch` with the captured shapes — no test ever touches the network.
 */
export * as sunoFixtures from './music/suno.fixtures';

/** An `EmailSender` that keeps every mail instead of sending it. */
export function recordingEmailSender(): EmailSender & { readonly sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push({ ...message });
    },
  };
}
