// Encrypt provider stream/final URLs at rest. Provider audio
// URLs are signed and SERVER-SIDE ONLY — they must never reach the browser, the
// logs, or any serializable column in plaintext. `track_audio_assets`
// stores them in the `text` column `encrypted_source_url`, so the AES-256-GCM
// envelope (the same crypto guarding provider credentials) is JSON-serialized to a
// string here and parsed back on read.

import { decryptSecret, encryptSecret, isEncryptedSecret } from '../credentials/crypto';

/** Seal a provider URL into a serialized AES-256-GCM envelope for at-rest storage. */
export function encryptSourceUrl(url: string, key: Buffer): string {
  return JSON.stringify(encryptSecret(url, key));
}

/**
 * Open a serialized source-URL envelope, returning the original provider URL. Throws
 * on a malformed (non-JSON / non-envelope) value or a GCM auth failure (wrong key /
 * tampering) — never returns a partial or corrupted URL.
 */
export function decryptSourceUrl(serialized: string, key: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('malformed encrypted source url');
  }
  if (!isEncryptedSecret(parsed)) throw new Error('malformed encrypted source url');
  return decryptSecret(parsed, key);
}
