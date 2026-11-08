import { describe, expect, it } from 'vitest';
import { createLogger, redact, REDACTED } from './logger';

function capture() {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => lines.push(line),
    now: () => '2026-01-01T00:00:00.000Z',
  };
}

describe('redact', () => {
  it('strips URL query strings, where provider signatures ride', () => {
    const out = redact({
      location: 'https://cdn.example.com/audio/track.mp3?X-Amz-Signature=deadbeef&token=abc',
      note: 'fetched https://api.example.com/v1/record-info?taskId=t_1 twice',
    }) as Record<string, unknown>;

    expect(out.location).toBe('https://cdn.example.com/audio/track.mp3');
    expect(out.note).toBe('fetched https://api.example.com/v1/record-info twice');
  });

  it('redacts sensitive keys regardless of casing/separators', () => {
    const out = redact({
      apiKey: 'abc',
      api_key: 'def',
      'API-KEY': 'ghi',
      authorization: 'Bearer xyz',
      password: 'hunter2',
      normal: 'kept',
    }) as Record<string, unknown>;

    expect(out.apiKey).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(out['API-KEY']).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.normal).toBe('kept');
  });

  it('redacts provider audio URLs by field name', () => {
    const out = redact({
      streamAudioUrl: 'https://provider.example/stream/abc',
      audioUrl: 'https://provider.example/final/abc',
      title: 'Focus Flow',
    }) as Record<string, unknown>;

    expect(out.streamAudioUrl).toBe(REDACTED);
    expect(out.audioUrl).toBe(REDACTED);
    expect(out.title).toBe('Focus Flow');
  });

  it('redacts bearer tokens and sk- keys inside string values', () => {
    const out = redact({
      note: 'called provider with Authorization: Bearer abc.def-123 ok',
      detail: 'key sk-livesecret12345 was used',
    }) as Record<string, unknown>;

    expect(out.note).toContain(REDACTED);
    expect(out.note).not.toContain('abc.def-123');
    expect(out.detail).toContain(REDACTED);
    expect(out.detail).not.toContain('sk-livesecret12345');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redact({
      provider: { config: { token: 'secret' } },
      jobs: [{ apiKey: 'k1' }, { apiKey: 'k2' }],
    }) as Record<string, unknown>;

    expect((out.provider as Record<string, Record<string, unknown>>).config?.token).toBe(REDACTED);
    expect((out.jobs as Array<Record<string, unknown>>)[0]?.apiKey).toBe(REDACTED);
    expect((out.jobs as Array<Record<string, unknown>>)[1]?.apiKey).toBe(REDACTED);
  });

  it('handles circular references without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.name).toBe('x');
    expect(out.self).toBe('[Circular]');
  });

  it('serializes Error instances with a redacted message and stack', () => {
    const out = redact(new Error('failed with Bearer abc.def-123')) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.message).toContain(REDACTED);
    expect(typeof out.stack).toBe('string');
    // The secret embedded in the message also appears in stack's first line.
    expect(out.stack).toContain(REDACTED);
    expect(out.stack).not.toContain('abc.def-123');
  });

  it('redacts a secret key embedded in an Error stack', () => {
    const out = redact(new Error('boom with key sk-livesecret12345')) as Record<string, unknown>;
    expect(out.stack).toContain(REDACTED);
    expect(out.stack).not.toContain('sk-livesecret12345');
  });

  it('redacts connection-string credentials by field name', () => {
    const out = redact({
      databaseUrl: 'postgres://liedmotif:secretpw@db:5432/liedmotif',
      DATABASE_URL: 'postgres://liedmotif:secretpw@db:5432/liedmotif',
      dsn: 'postgres://u:secretpw@db/liedmotif',
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) {
      expect(value).toBe(REDACTED);
      expect(value).not.toContain('secretpw');
      expect(value).not.toContain(':secretpw@');
    }
  });

  it('redacts inline URL credentials even in a non-sensitive field name', () => {
    const out = redact({
      note: 'connecting via postgres://liedmotif:secretpw@db:5432/liedmotif now',
    }) as Record<string, unknown>;

    expect(out.note).not.toContain('secretpw');
    expect(out.note).not.toContain(':secretpw@');
    expect(out.note).toContain('postgres://[REDACTED]@db:5432/liedmotif');
  });

  it('redacts URL userinfo with OR without a password (token-as-username)', () => {
    const out = redact({
      // Benign key names, so this exercises VALUE-level userinfo redaction.
      hookNote: 'webhook at https://SECRETTOKEN@example.com/hook fired',
      callbackUrl: 'https://user:hunter2@host/p',
      conn: 'postgres://u:p@h:5432/db',
      // A bare email in prose has no `://` and must be left untouched.
      contact: 'reach a@b.com for help',
      // An `@` in the query is not userinfo: the host survives (the query
      // itself goes, as it does on every logged URL).
      query: 'https://api.example.com?to=a@b.com',
    }) as Record<string, string>;

    expect(out.hookNote).toContain('https://[REDACTED]@example.com/hook');
    expect(out.hookNote).not.toContain('SECRETTOKEN');
    expect(out.callbackUrl).toBe('https://[REDACTED]@host/p');
    expect(out.conn).toBe('postgres://[REDACTED]@h:5432/db');
    expect(out.contact).toBe('reach a@b.com for help');
    expect(out.query).toBe('https://api.example.com');
  });

  it('redacts prompt content fields', () => {
    const out = redact({
      generationPrompt: 'a private prompt the user typed',
      stylePrompt: 'lo-fi study beats',
      activity: 'focus',
    }) as Record<string, unknown>;

    expect(out.generationPrompt).toBe(REDACTED);
    expect(out.stylePrompt).toBe(REDACTED);
    expect(out.activity).toBe('focus');
  });

  it('redacts credential fields (encrypted secret envelope, encryption key)', () => {
    const out = redact({
      encryptedSecret: { v: 1, iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y2lwaGVy' },
      CREDENTIAL_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODw==',
      sunoApiKey: 'sk-live-suno-1234',
      providerKey: 'suno',
    }) as Record<string, unknown>;

    expect(out.encryptedSecret).toBe(REDACTED);
    expect(out.CREDENTIAL_ENCRYPTION_KEY).toBe(REDACTED);
    expect(out.sunoApiKey).toBe(REDACTED);
    // `providerKey` is an open-vocabulary identifier (e.g. "suno"), not a secret.
    expect(out.providerKey).toBe('suno');
  });

  it('redacts authorization but not benign author fields', () => {
    const out = redact({
      authorization: 'Bearer abc.def',
      author: 'Ada Lovelace',
      authorName: 'Ada Lovelace',
      generatedArtistName: 'The Focus Collective',
    }) as Record<string, unknown>;

    expect(out.authorization).toBe(REDACTED);
    expect(out.author).toBe('Ada Lovelace');
    expect(out.authorName).toBe('Ada Lovelace');
    expect(out.generatedArtistName).toBe('The Focus Collective');
  });
});

describe('createLogger', () => {
  it('emits one JSON line per call with level, msg, time, and name', () => {
    const cap = capture();
    const log = createLogger({ name: 'web', level: 'info', sink: cap.sink, now: cap.now });
    log.info('hello', { route: '/api/health' });

    expect(cap.lines).toHaveLength(1);
    const entry = JSON.parse(cap.lines[0]!);
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'hello',
      name: 'web',
      time: '2026-01-01T00:00:00.000Z',
      route: '/api/health',
    });
  });

  it('redacts sensitive fields passed at the call site', () => {
    const cap = capture();
    const log = createLogger({ level: 'info', sink: cap.sink, now: cap.now });
    log.info('provider call', { apiKey: 'super-secret' });
    const entry = JSON.parse(cap.lines[0]!);
    expect(entry.apiKey).toBe(REDACTED);
  });

  it('filters out entries below the configured level', () => {
    const cap = capture();
    const log = createLogger({ level: 'warn', sink: cap.sink, now: cap.now });
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    expect(cap.lines).toHaveLength(2);
  });

  it('child loggers merge bindings into every line', () => {
    const cap = capture();
    const log = createLogger({ level: 'info', sink: cap.sink, now: cap.now });
    const child = log.child({ sessionId: 'abc' });
    child.info('event');
    const entry = JSON.parse(cap.lines[0]!);
    expect(entry.sessionId).toBe('abc');
  });
});
