import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSourceUrl, encryptSourceUrl } from './source-url-crypto';

const KEY = randomBytes(32);
const URL = 'https://cdn.example/stream/6ee24fe5-78bf-46da-b717-37d35ece5fb5?sig=abc';

describe('source-url crypto', () => {
  it('round-trips a provider URL through an encrypted, serialized envelope', () => {
    const sealed = encryptSourceUrl(URL, KEY);
    expect(sealed).not.toContain('cdn.example'); // ciphertext, not the URL
    expect(sealed).not.toContain('http');
    expect(decryptSourceUrl(sealed, KEY)).toBe(URL);
  });

  it('produces a different ciphertext each time (fresh IV) but the same plaintext', () => {
    const a = encryptSourceUrl(URL, KEY);
    const b = encryptSourceUrl(URL, KEY);
    expect(a).not.toBe(b);
    expect(decryptSourceUrl(a, KEY)).toBe(decryptSourceUrl(b, KEY));
  });

  it('throws on a non-JSON or non-envelope serialized value', () => {
    expect(() => decryptSourceUrl('not json', KEY)).toThrow();
    expect(() => decryptSourceUrl(JSON.stringify({ nope: 1 }), KEY)).toThrow();
  });

  it('throws when decrypted with the wrong key (GCM auth failure)', () => {
    const sealed = encryptSourceUrl(URL, KEY);
    expect(() => decryptSourceUrl(sealed, randomBytes(32))).toThrow();
  });
});
