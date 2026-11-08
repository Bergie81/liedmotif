// File-extension normalization, kept as a leaf module so both the key layout and
// content-type inference can depend on it without an import cycle.

/** Normalize a file extension to a bare, lowercased token (`.MP3` -> `mp3`). */
export function normalizeExtension(ext: string): string {
  return ext.replace(/^\.+/, '').toLowerCase();
}
