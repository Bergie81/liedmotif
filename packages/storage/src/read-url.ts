// App-routed read URLs, shared by every adapter. The browser only ever sees an
// app route carrying the storage key — never a filesystem path, bucket URL, or
// presigned material — so the owner-authorization boundary stays in the app.

import { assertSafeKey } from './safe-key';

const DEFAULT_READ_URL_BASE = '/api/files';

/** An adapter's read-URL base: the configured one or the app default, with
 *  trailing slashes stripped so it joins cleanly with a key. */
export function resolveReadUrlBase(configured?: string): string {
  return (configured ?? DEFAULT_READ_URL_BASE).replace(/\/+$/, '');
}

/** Build the app-routed URL for a (validated) storage key. */
export function appRoutedReadUrl(readUrlBase: string, key: string): string {
  assertSafeKey(key);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${readUrlBase}/${encoded}`;
}
