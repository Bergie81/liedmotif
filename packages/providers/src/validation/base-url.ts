// The shape rule for a provider base URL, applied where one is persisted.
//
// Provider CONFIG is deliberately non-secret: it is stored in plaintext beside
// the AES-GCM-encrypted `secret` and serialized back to the admin frontend. A
// pasted `https://user:password@host/v1` or `https://host/v1?token=…` — an
// ordinary shape for self-hosted and compatible endpoints — would therefore push
// authentication material out of the encrypted path into the database and the
// browser. Authentication belongs in the secret field, so a URL that carries its
// own is refused rather than stored.
//
// An accepted URL is returned as given (trimmed): adapters join paths onto it
// (`${baseUrl}/api/v1/...`), so rewriting one — adding or dropping a trailing
// slash, dropping a path — would change where an already-working instance points.

/** Why a base URL cannot be stored. */
export type ProviderBaseUrlRejection = 'not_http_url' | 'carries_authentication';

export type ProviderBaseUrlResult =
  { ok: true; baseUrl: string } | { ok: false; reason: ProviderBaseUrlRejection };

/** Validate a base URL for persistence, returning the value to store. */
export function normalizeProviderBaseUrl(value: string): ProviderBaseUrlResult {
  const baseUrl = value.trim();
  const url = URL.parse(baseUrl);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return { ok: false, reason: 'not_http_url' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, reason: 'carries_authentication' };
  }
  return { ok: true, baseUrl };
}
