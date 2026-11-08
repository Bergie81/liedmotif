import { describe, expect, it } from 'vitest';
import { normalizeProviderBaseUrl } from './base-url';

// Provider config is modelled as non-secret: it is stored in plaintext and
// serialized back to the admin's browser. A base URL that carries its own
// authentication would therefore ship a secret out of the encrypted path, so it
// is refused at the boundary rather than silently stored.

describe('normalizeProviderBaseUrl', () => {
  it('accepts the endpoint shapes providers actually use, unchanged', () => {
    for (const value of [
      'https://api.sunoapi.org',
      'https://api.openai.com/v1',
      'http://localhost:11434',
      'https://host.example/openai/v1/',
    ]) {
      expect(normalizeProviderBaseUrl(` ${value} `)).toEqual({ ok: true, baseUrl: value });
    }
  });

  it('refuses a URL carrying authentication material', () => {
    for (const value of [
      'https://user:password@host.example/v1',
      'https://token@host.example/v1',
      'https://host.example/v1?token=abc',
      'https://host.example/v1#key=abc',
    ]) {
      expect(normalizeProviderBaseUrl(value)).toEqual({
        ok: false,
        reason: 'carries_authentication',
      });
    }
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    for (const value of ['api.example.com/v1', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
      expect(normalizeProviderBaseUrl(value)).toEqual({ ok: false, reason: 'not_http_url' });
    }
  });
});
