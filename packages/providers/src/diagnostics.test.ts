import { describe, expect, it } from 'vitest';
import { buildProviderDiagnostics, redactProviderDiagnostics } from '@liedmotif/shared';

describe('redactProviderDiagnostics', () => {
  it('strips an Authorization header from a nested raw request', () => {
    const redacted = redactProviderDiagnostics({
      url: 'https://api.sunoapi.org/api/v1/generate',
      headers: { Authorization: 'Bearer sk-live-supersecret', accept: 'application/json' },
    }) as { headers: { Authorization: string; accept: string } };
    expect(redacted.headers.Authorization).toBe('[REDACTED]');
    expect(redacted.headers.accept).toBe('application/json');
  });

  it('strips bearer tokens and sk- keys embedded in string values', () => {
    const redacted = redactProviderDiagnostics({
      note: 'called with Bearer sk-live-abcdefgh and key sk-or-v1-deadbeefdead',
    }) as { note: string };
    expect(redacted.note).not.toContain('sk-live-abcdefgh');
    expect(redacted.note).not.toContain('sk-or-v1-deadbeefdead');
  });

  it('strips the query of a signed URL stored under an arbitrary key', () => {
    const redacted = redactProviderDiagnostics({
      assetUrl: 'https://cdn.suno.ai/tracks/abc.mp3?token=secrettoken&X-Amz-Signature=deadbeef',
    }) as { assetUrl: string };
    expect(redacted.assetUrl).toBe('https://cdn.suno.ai/tracks/abc.mp3');
    expect(redacted.assetUrl).not.toContain('Signature');
    expect(redacted.assetUrl).not.toContain('secrettoken');
  });

  it('fully redacts values under known provider-URL keys', () => {
    const redacted = redactProviderDiagnostics({
      audioUrl: 'https://cdn.suno.ai/final.mp3?sig=abc',
      streamAudioUrl: 'https://cdn.suno.ai/stream.mp3?sig=def',
    }) as { audioUrl: string; streamAudioUrl: string };
    expect(redacted.audioUrl).toBe('[REDACTED]');
    expect(redacted.streamAudioUrl).toBe('[REDACTED]');
  });

  it('strips inline URL credentials but keeps the host and path', () => {
    const redacted = redactProviderDiagnostics({
      callback: 'https://user:hunter2@example.com/hook',
    }) as { callback: string };
    expect(redacted.callback).not.toContain('hunter2');
    expect(redacted.callback).toContain('example.com');
  });

  it('strips a userinfo-only token (token-as-username) from a callback URL', () => {
    const redacted = redactProviderDiagnostics({
      callback: 'https://SECRETTOKEN9@example.com/webhook',
    }) as { callback: string };
    expect(redacted.callback).toBe('https://[REDACTED]@example.com/webhook');
    expect(redacted.callback).not.toContain('SECRETTOKEN9');
  });

  it('RETAINS the prompt and generation params (unlike the logger redactor)', () => {
    const redacted = redactProviderDiagnostics({
      prompt: 'instrumental lofi beats for studying',
      style: 'chillhop, mellow',
      title: 'Focus Drift',
      negativeTags: 'vocals, aggressive',
      model: 'V5',
    });
    expect(redacted).toEqual({
      prompt: 'instrumental lofi beats for studying',
      style: 'chillhop, mellow',
      title: 'Focus Drift',
      negativeTags: 'vocals, aggressive',
      model: 'V5',
    });
  });

  it('strips the query of a signed URL EMBEDDED in a larger string', () => {
    const redacted = redactProviderDiagnostics({
      message:
        'failed to download from https://cdn.suno.ai/x.mp3?token=SECRET&X-Amz-Signature=DEAD now',
    }) as { message: string };
    expect(redacted.message).toBe('failed to download from https://cdn.suno.ai/x.mp3 now');
  });

  it('strips query secrets on non-http(s) URL schemes (ws/callback)', () => {
    const redacted = redactProviderDiagnostics({
      webhookUrl: 'wss://host/path?token=WS_SECRET_123',
    }) as { webhookUrl: string };
    expect(redacted.webhookUrl).toBe('wss://host/path');
  });

  it('strips JWT and AWS-key value formats regardless of key name', () => {
    const redacted = redactProviderDiagnostics({
      assertion: 'eyJhbGci.eyJzdWIiOiJ1c2VyIn0.SIGNATUREPARTSECRET',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('SIGNATUREPARTSECRET');
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts secrets inside arrays and nested structures', () => {
    const redacted = redactProviderDiagnostics({
      items: [
        { url: 'https://cdn/a.mp3?sig=leak1' },
        { authorization: 'Bearer sk-leak2-aaaaaaaa' },
      ],
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('leak1');
    expect(serialized).not.toContain('sk-leak2-aaaaaaaa');
  });

  it('redacts an Error payload (message and stack) without throwing on cycles', () => {
    const cyclic: Record<string, unknown> = { token: 'sk-leak-cycle-aaaaaaaa' };
    cyclic.self = cyclic;
    expect(() => redactProviderDiagnostics(cyclic)).not.toThrow();

    const redacted = redactProviderDiagnostics(
      new Error('boom from https://cdn/x.mp3?sig=errleak'),
    ) as { message: string };
    expect(redacted.message).toBe('boom from https://cdn/x.mp3');
  });

  it('never lets a secret survive serialization of the redacted output', () => {
    const redacted = redactProviderDiagnostics({
      request: { apiKey: 'sk-live-leak-me', headers: { authorization: 'Bearer sk-live-leak-me' } },
      response: { downloadUrl: 'https://cdn/x.mp3?token=tok-leak-me' },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-live-leak-me');
    expect(serialized).not.toContain('tok-leak-me');
  });
});

describe('buildProviderDiagnostics', () => {
  it('redacts each present field and omits absent ones', () => {
    const diag = buildProviderDiagnostics({
      rawRequest: { headers: { authorization: 'Bearer sk-leak-build-aaaa' } },
      rawResponse: { audioUrl: 'https://cdn/x.mp3?sig=leak' },
    });
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain('sk-leak-build-aaaa');
    expect(serialized).not.toContain('sig=leak');

    const onlyRequest = buildProviderDiagnostics({ rawRequest: { prompt: 'lofi' } });
    expect(Object.keys(onlyRequest)).toEqual(['rawRequest']);
  });

  it('makes it a compile error to store a raw, unredacted payload', () => {
    const raw: unknown = { authorization: 'Bearer sk-do-not-store' };
    // @ts-expect-error raw payloads are not assignable to a ProviderDiagnostics field.
    const bad: import('@liedmotif/shared').ProviderDiagnostics = { rawRequest: raw };
    expect(bad).toBeDefined();
  });
});
