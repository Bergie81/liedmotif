// Best-effort MIME inference from a storage key's extension. The filesystem does
// not record a content type, so reads/stats derive one from the key. The set is
// intentionally small — the audio and cover formats Liedmotif actually stores —
// and falls back to a binary type rather than guessing.

import { normalizeExtension } from './extension';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wav: 'audio/wav',
  webp: 'image/webp',
  png: 'image/png',
  svg: 'image/svg+xml', // the built-in placeholder cover is an app-shipped SVG
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  zip: 'application/zip',
  json: 'application/json',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** What audio bytes fall back to: the dominant provider format, and the type that
 *  pairs with `extensionForContentType`'s own mp3 fallback. */
const DEFAULT_AUDIO_CONTENT_TYPE = 'audio/mpeg';

/** Infer a MIME type from a key's file extension, or the binary default. */
export function contentTypeForKey(key: string): string {
  // Only look at the final path segment, so a dot in a parent directory
  // (`tracks/a.mp3/original`) can't be mistaken for the object's extension.
  const basename = key.slice(key.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_CONTENT_TYPE; // no extension, or a dotfile like `.gitignore`
  return CONTENT_TYPES[normalizeExtension(basename.slice(dot))] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * The canonical extension for a downloaded object's `Content-Type`, used to name a
 * stored audio file when the source URL carries no usable extension (provider final
 * audio). The reverse of `contentTypeForKey`'s audio rows, plus the non-standard
 * `audio/mp3`. Parameters (`; charset=…`), case, and whitespace are ignored. An
 * absent or unrecognized type falls back to `fallback` (mp3 — the dominant provider
 * audio format) rather than guessing a binary extension.
 */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
};

export function extensionForContentType(
  contentType: string | null | undefined,
  fallback = 'mp3',
): string {
  if (!contentType) return fallback;
  const base = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return EXTENSION_BY_CONTENT_TYPE[base] ?? fallback;
}

/** The audio types this app stores and serves — the audio rows of `CONTENT_TYPES`,
 *  so a format the key mapper knows is a format the audio routes may serve. */
const SERVABLE_AUDIO_TYPES = new Set(
  Object.values(CONTENT_TYPES).filter((type) => type.startsWith('audio/')),
);

/**
 * The `Content-Type` to persist or serve for audio bytes whose declared type came
 * from OUTSIDE this app — a provider response, or a row written from one. Anything
 * off the servable audio set (a hostile or MITM'd `text/html`) would otherwise be
 * echoed back and render inline in the application origin on a top-level GET; it
 * becomes mp3 instead, matching the extension `extensionForContentType` gives the
 * same bytes, so the served type and the storage key can never disagree. Real audio
 * keeps its real type, so playback is untouched.
 */
export function audioContentType(contentType: string | null | undefined): string {
  if (!contentType) return DEFAULT_AUDIO_CONTENT_TYPE;
  const base = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return SERVABLE_AUDIO_TYPES.has(base) ? base : DEFAULT_AUDIO_CONTENT_TYPE;
}
