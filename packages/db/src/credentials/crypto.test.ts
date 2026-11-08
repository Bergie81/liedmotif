import { describe, expect, it } from 'vitest';
import {
  CRYPTO_VERSION,
  DecryptionError,
  EncryptionKeyError,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  loadEncryptionKey,
} from './crypto';

// A throwaway, well-formed 32-byte key (base64). NOT a real key — tests only.
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const key = decodeEncryptionKey(TEST_KEY_B64);

describe('credential crypto round-trip', () => {
  it('decrypts what it encrypts (AES-256-GCM)', () => {
    const secret = encryptSecret('sk-super-secret-suno-key', key);
    expect(decryptSecret(secret, key)).toBe('sk-super-secret-suno-key');
  });

  it('round-trips unicode and empty strings', () => {
    for (const plaintext of ['', 'plain', '🎵 ünïcødé key 名前']) {
      expect(decryptSecret(encryptSecret(plaintext, key), key)).toBe(plaintext);
    }
  });
});

describe('encrypted-secret envelope format', () => {
  it('stores version + base64 iv(12 bytes) + tag(16 bytes) + ciphertext', () => {
    const secret = encryptSecret('abc', key);
    expect(secret.v).toBe(CRYPTO_VERSION);
    expect(Buffer.from(secret.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(secret.tag, 'base64')).toHaveLength(16);
    expect(typeof secret.ciphertext).toBe('string');
    expect(isEncryptedSecret(secret)).toBe(true);
  });

  it('uses a fresh random IV per secret (same plaintext → different envelope)', () => {
    const a = encryptSecret('same-input', key);
    const b = encryptSecret('same-input', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ...yet both still decrypt to the same plaintext.
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key));
  });

  it('isEncryptedSecret rejects non-envelopes', () => {
    expect(isEncryptedSecret(null)).toBe(false);
    expect(isEncryptedSecret('nope')).toBe(false);
    expect(isEncryptedSecret({ v: 1, iv: 'x' })).toBe(false);
  });
});

describe('tamper detection (GCM auth tag)', () => {
  it('throws when the ciphertext is tampered with', () => {
    const secret = encryptSecret('keep me intact', key);
    const tampered = { ...secret, ciphertext: flipFirstByte(secret.ciphertext) };
    expect(() => decryptSecret(tampered, key)).toThrow(DecryptionError);
  });

  it('throws when the auth tag is tampered with', () => {
    const secret = encryptSecret('keep me intact', key);
    const tampered = { ...secret, tag: flipFirstByte(secret.tag) };
    expect(() => decryptSecret(tampered, key)).toThrow(DecryptionError);
  });

  it('throws when decrypted with the wrong key', () => {
    const secret = encryptSecret('keep me intact', key);
    const otherKey = decodeEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
    expect(() => decryptSecret(secret, otherKey)).toThrow(DecryptionError);
  });

  it('throws on an unsupported envelope version', () => {
    const secret = encryptSecret('x', key);
    expect(() => decryptSecret({ ...secret, v: 999 }, key)).toThrow(/version/);
  });

  it('never leaks plaintext or key material in the error message', () => {
    const secret = encryptSecret('TOP-SECRET-VALUE', key);
    const tampered = { ...secret, ciphertext: flipFirstByte(secret.ciphertext) };
    try {
      decryptSecret(tampered, key);
      throw new Error('expected decryptSecret to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('TOP-SECRET-VALUE');
      expect(message).not.toContain(TEST_KEY_B64);
    }
  });
});

describe('key validation (fail fast)', () => {
  it('rejects a key that does not decode to exactly 32 bytes', () => {
    expect(() => decodeEncryptionKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(
      EncryptionKeyError,
    );
    expect(() => decodeEncryptionKey(Buffer.alloc(48, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  it('rejects an empty key', () => {
    expect(() => decodeEncryptionKey('')).toThrow(EncryptionKeyError);
  });

  it('loadEncryptionKey throws when the env var is missing', () => {
    expect(() => loadEncryptionKey({})).toThrow(EncryptionKeyError);
  });

  it('loadEncryptionKey returns the 32-byte key when configured', () => {
    expect(loadEncryptionKey({ CREDENTIAL_ENCRYPTION_KEY: TEST_KEY_B64 })).toHaveLength(32);
  });
});

/** Flip the first byte of a base64 blob to simulate corruption. */
function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
  return bytes.toString('base64');
}
