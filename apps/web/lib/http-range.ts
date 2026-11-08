// Shared HTTP Range parsing for the app-routed audio byte routes.
//
// Per RFC 7233, a Range we can't honor as a single byte range — absent, malformed,
// or a multi-range (we never emit `multipart/byteranges`) — is IGNORED and the full
// body is returned (200). ONLY a syntactically valid but out-of-bounds single range
// is `unsatisfiable` (416). Pure and total, so every Range-serving route shares
// one reviewed implementation.

export type RangeOutcome =
  { kind: 'full' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

/** Parse a `Range` header against a known object size into a serving outcome. */
export function parseAudioRange(header: string | null, total: number): RangeOutcome {
  if (!header) return { kind: 'full' };
  const trimmed = header.trim();
  // Multi-range (comma) is satisfiable but unsupported → ignore, serve full body.
  if (trimmed.includes(',')) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  // Malformed/unparseable Range → ignore, serve full body (not 416).
  if (!match) return { kind: 'full' };

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: last N bytes. "bytes=-" is malformed (ignore); a 0-length suffix
    // is unsatisfiable.
    if (rawEnd === '') return { kind: 'full' };
    const suffix = Number(rawEnd);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'range', start, end };
}
