// AES-256-GCM envelope encryption for provider secrets stored at rest.
//
// Only encrypted secrets are ever written to the database: a secret is
// sealed into an `EncryptedSecret` envelope — version + random 12-byte IV + GCM
// auth tag + ciphertext, all base64 — so the IV/tag travel with the ciphertext and
// a future key rotation can bump the version. GCM is authenticated: any tampering
// with the ciphertext or tag makes `decryptSecret` throw rather than return
// corrupted plaintext. Keys are validated to be exactly 32 bytes and the module
// fails fast on an invalid `CREDENTIAL_ENCRYPTION_KEY` (see `loadEncryptionKey`).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '../schema/types';

/** Current envelope scheme version. Bumped only if the format/algorithm changes. */
export const CRYPTO_VERSION = 1;

/** The environment variable holding the base64-encoded 32-byte master key. */
export const ENCRYPTION_KEY_ENV = 'CREDENTIAL_ENCRYPTION_KEY';

const ALGORITHM = 'aes-256-gcm';
/** AES-256 needs a 32-byte key. */
const KEY_BYTES = 32;
/** 96-bit IV is the GCM-recommended size; a fresh random one per secret. */
const IV_BYTES = 12;
/** GCM produces a 128-bit (16-byte) authentication tag. */
const TAG_BYTES = 16;

/**
 * Thrown for invalid encryption-key configuration — boot should fail fast on it —
 * and when a stored secret is read with no key configured.
 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

/** Thrown when a secret cannot be decrypted (tampering, wrong key, bad envelope). */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Decode and validate a base64-encoded master key, returning the raw 32 bytes.
 * Throws `EncryptionKeyError` on anything that isn't a well-formed 32-byte key, so
 * a misconfigured key is caught loudly instead of corrupting stored secrets. The
 * error message never includes the key material.
 */
export function decodeEncryptionKey(base64Key: string): Buffer {
  if (typeof base64Key !== 'string' || base64Key.trim() === '') {
    throw new EncryptionKeyError(`${ENCRYPTION_KEY_ENV} must be a non-empty base64 string`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64Key, 'base64');
  } catch {
    throw new EncryptionKeyError(`${ENCRYPTION_KEY_ENV} is not valid base64`);
  }
  // `Buffer.from(..., 'base64')` is lenient (it silently ignores characters that
  // aren't valid base64), so the security-relevant guard is the decoded byte
  // length: a malformed or wrong-size key never slips through as a 32-byte key.
  if (decoded.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `${ENCRYPTION_KEY_ENV} must decode to ${KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

/**
 * Load the master key from the environment, failing fast when it is missing or
 * invalid. Call this at boot when DB-stored secrets are enabled so a broken key is
 * a startup error, not a first-write surprise.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[ENCRYPTION_KEY_ENV];
  if (raw === undefined || raw === '') {
    throw new EncryptionKeyError(
      `${ENCRYPTION_KEY_ENV} is required when DB-stored secrets are enabled`,
    );
  }
  return decodeEncryptionKey(raw);
}

/** Seal `plaintext` into a versioned AES-256-GCM envelope using a fresh random IV. */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: CRYPTO_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Open an `EncryptedSecret` envelope, returning the original plaintext. Throws
 * `DecryptionError` if the version is unsupported, the envelope is malformed, or
 * the GCM auth tag fails (tampered ciphertext/tag or wrong key). The error carries
 * no secret material.
 */
export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  if (secret.v !== CRYPTO_VERSION) {
    throw new DecryptionError(`unsupported encrypted-secret version: ${secret.v}`);
  }
  const iv = Buffer.from(secret.iv, 'base64');
  const tag = Buffer.from(secret.tag, 'base64');
  const ciphertext = Buffer.from(secret.ciphertext, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('malformed encrypted-secret envelope');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Swallow the underlying crypto error so nothing about the key/plaintext leaks.
    throw new DecryptionError('failed to decrypt secret (tampered data or wrong key)');
  }
}

/** Structural type guard for a stored `EncryptedSecret` envelope. */
export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.v === 'number' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.tag === 'string' &&
    typeof candidate.ciphertext === 'string'
  );
}
