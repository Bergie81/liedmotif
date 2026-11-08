// UI-safe masking for secrets. The frontend only ever sees a masked credential
// (keys must never reach the client), so the resolution layer renders
// stored/env secrets through this before they leave the server.

/** Number of trailing characters revealed for a sufficiently long secret. */
const VISIBLE_SUFFIX = 4;
const MASK_CHAR = '•';

/**
 * Mask a secret for display: reveal only the last 4 characters of a long secret,
 * and fully mask anything short enough that a suffix would expose too much — using
 * a fixed-width mask so the output never leaks the secret's true length.
 */
export function maskSecret(value: string): string {
  if (value.length === 0) return '';
  const mask = MASK_CHAR.repeat(VISIBLE_SUFFIX);
  if (value.length <= VISIBLE_SUFFIX * 2) return mask;
  return mask + value.slice(-VISIBLE_SUFFIX);
}
