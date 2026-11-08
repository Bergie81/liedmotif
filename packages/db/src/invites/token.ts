// One-shot link tokens. The plaintext exists only inside the URL the Admin
// copies; rows store the SHA-256 so a database read can never mint a working
// link. 32 random bytes (base64url) is far beyond brute-force reach, so no
// per-token salt is needed — unlike passwords, tokens are never user-chosen.

import { createHash, randomBytes } from 'node:crypto';

export interface GeneratedToken {
  /** The URL secret. Hand it to the Admin once; never log or persist it. */
  token: string;
  /** SHA-256 hex of `token` — the only form that touches the database. */
  tokenHash: string;
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateLinkToken(): GeneratedToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashLinkToken(token) };
}
