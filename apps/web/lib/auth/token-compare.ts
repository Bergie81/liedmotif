import { createHash, timingSafeEqual } from 'node:crypto';

/** Comparable fixed-width digest of a token. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Whether `request` carries the configured token in `headerName`, compared in
 * constant time. Surrounding whitespace on the presented value is ignored.
 *
 * Digesting before comparing is what makes the check safe for ANY presented
 * value: `timingSafeEqual` throws on a length mismatch, so comparing the raw
 * strings would turn a wrong-length guess into a 500 — and into a length
 * oracle. Two SHA-256 digests are always the same width. An absent header reads
 * as `''`, which a non-empty configured token can never match; what an unset
 * token means is each gate's own policy.
 */
export function requestCarriesToken(
  request: Request,
  headerName: string,
  configured: string,
): boolean {
  const presented = request.headers.get(headerName)?.trim() ?? '';
  return timingSafeEqual(digest(configured), digest(presented));
}
