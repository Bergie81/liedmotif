import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EmailSendError, smtpEmailSender } from './index';

// The delivery leg runs against a REAL Mailpit (`npm run mail:test:up`), gated as
// a whole on its two test variables — an absent Mailpit is a visible skip, never
// a silently swapped path.
const TEST_SMTP_URL = process.env.TEST_SMTP_URL?.trim() || undefined;
const TEST_MAILPIT_URL = process.env.TEST_MAILPIT_URL?.trim() || undefined;

const FROM = 'Liedmotif <liedmotif@example.test>';

describe.skipIf(!TEST_SMTP_URL || !TEST_MAILPIT_URL)('smtpEmailSender (Mailpit)', () => {
  it('delivers the recipient, sender, subject, and plain text as given', async () => {
    const id = randomUUID();
    const to = `member-${id}@example.test`;
    const subject = `Reset your Liedmotif password ${id}`;
    const text = `Open this link within an hour:\nhttps://liedmotif.example/reset/${id}\n`;

    await smtpEmailSender({ url: TEST_SMTP_URL!, from: FROM }).send({ to, subject, text });

    const query = encodeURIComponent(`to:"${to}"`);
    const search = await fetch(`${TEST_MAILPIT_URL}/api/v1/search?query=${query}`);
    const { messages } = (await search.json()) as { messages: { ID: string }[] };
    expect(messages).toHaveLength(1);
    const message = (await (
      await fetch(`${TEST_MAILPIT_URL}/api/v1/message/${messages[0]!.ID}`)
    ).json()) as { From: unknown; To: unknown; Subject: string; Text: string };
    expect(message.From).toMatchObject({ Name: 'Liedmotif', Address: 'liedmotif@example.test' });
    expect(message.To).toMatchObject([{ Address: to }]);
    expect(message.Subject).toBe(subject);
    expect(message.Text.replace(/\r\n/g, '\n')).toBe(text);
  });
});

describe('smtpEmailSender failures', () => {
  it('throws an EmailSendError carrying only a code, never the URL, reply, or message', async () => {
    // A mail server that refuses the session and echoes what a careless adapter
    // would pass through: its own reply text.
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.write('554 5.7.1 refused tok-secret member@example.test\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const sender = smtpEmailSender({
        url: `smtp://liedmotif:smtp-password@127.0.0.1:${port}`,
        from: FROM,
      });
      const error = await sender
        .send({
          to: 'member@example.test',
          subject: 'Reset your Liedmotif password',
          text: 'https://liedmotif.example/reset/tok-secret',
        })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(EmailSendError);
      expect((error as EmailSendError).code).toBe('EPROTOCOL');
      expect((error as EmailSendError).cause).toBeUndefined();
      const surfaced = [(error as Error).message, (error as Error).stack, JSON.stringify(error)];
      for (const secret of ['smtp-password', 'tok-secret', 'member@example.test', '554']) {
        expect(surfaced.join('\n')).not.toContain(secret);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('turns a URL nodemailer cannot use into the same code-only EmailSendError', async () => {
    // A valid URL whose host nodemailer refuses; its parse error carries the
    // whole URL, password included.
    const sender = smtpEmailSender({
      url: 'smtp://liedmotif:smtp-password@exa%20mple.com:25',
      from: FROM,
    });

    const error = await sender
      .send({ to: 'member@example.test', subject: 's', text: 't' })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(EmailSendError);
    expect(JSON.stringify(error)).not.toContain('smtp-password');
  });
});
