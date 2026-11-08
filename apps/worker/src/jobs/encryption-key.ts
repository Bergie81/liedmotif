// The music pipeline seals provider stream/final URLs at rest, so the
// poll/process/download tasks REQUIRE the AES-256-GCM master key. Boot resolves it
// once and may pass `null` (no `CREDENTIAL_ENCRYPTION_KEY` configured); these tasks
// then fail loudly at run time — a visible, retried Graphile error — rather than
// silently storing or serving an unencrypted provider URL. The non-pipeline jobs
// (sweep, eviction, analysis, buffer submit) never touch the key and keep running.

const MISSING_KEY_MESSAGE =
  'CREDENTIAL_ENCRYPTION_KEY is required to run the music generation pipeline ' +
  '(provider URLs are encrypted at rest); set it to a base64 32-byte key.';

/** Narrow a possibly-absent key to a Buffer, throwing a sanitized error when absent. */
export function requireEncryptionKey(key: Buffer | null): Buffer {
  if (!key) throw new Error(MISSING_KEY_MESSAGE);
  return key;
}
