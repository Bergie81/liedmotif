// Reader for the violation documents browsers post to `report-uri`. The exact
// field set differs per browser and per violation, so the fields are taken
// leniently: a report naming only the directive still earns a log line, and a
// stricter parse would drop the evidence the endpoint exists to collect.
//
// Two fields are deliberately shaped rather than passed through. URL fields are
// page URLs, and the invite/reset/confirm links carry their token in the PATH
// (`/join/<token>`), where the logger's redaction — userinfo and query strings —
// does not reach; a logged report must never be a claimable account, so those
// segments are dropped. `script-sample` is never read at all: it is a slice of
// the page's own content.

/** The loggable shape of one violation — a log-fields object, hence a type. */
export type CspViolation = {
  directive: string;
  blockedUri?: string;
  documentUri?: string;
  sourceFile?: string;
  line?: number;
  disposition?: string;
};

/** Route prefixes whose next path segment is a claimable one-shot token. */
const TOKEN_PATH_PREFIXES = ['/join/', '/reset/', '/confirm/'];

/** Report fields are attacker-influenceable strings; bound what reaches a log line. */
const MAX_FIELD_CHARS = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * A URL field reduced to what a log is read for: origin plus path, with a token
 * segment dropped. Non-URL values (`inline`, `eval`, `self`) pass through, and a
 * non-http scheme (`data:`, `blob:`) is reported as the scheme alone — its body
 * is payload, not a location.
 */
function sanitizeUrlField(value: string): string {
  const trimmed = value.trim().slice(0, MAX_FIELD_CHARS);
  const url = URL.parse(trimmed);
  if (!url) return trimmed;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol;
  const tokenPath = TOKEN_PATH_PREFIXES.find((prefix) => url.pathname.startsWith(prefix));
  return `${url.origin}${tokenPath ?? url.pathname}`;
}

function readString(doc: Record<string, unknown>, key: string): string | undefined {
  const value = doc[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readUrl(doc: Record<string, unknown>, key: string): string | undefined {
  const value = readString(doc, key);
  return value === undefined ? undefined : sanitizeUrlField(value);
}

function readLine(doc: Record<string, unknown>): number | undefined {
  const value = doc['line-number'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The loggable violation from a posted `{"csp-report": {…}}` document, or null
 * when the body names no directive — with nothing to say which rule fired, a
 * report is noise.
 */
export function readCspViolation(body: unknown): CspViolation | null {
  const doc = asRecord(asRecord(body)?.['csp-report']);
  if (!doc) return null;
  const directive = readString(doc, 'effective-directive') ?? readString(doc, 'violated-directive');
  if (!directive) return null;
  // Absent fields stay `undefined`: the logger serializes with `JSON.stringify`,
  // which drops them from the line.
  return {
    directive: directive.slice(0, MAX_FIELD_CHARS),
    blockedUri: readUrl(doc, 'blocked-uri'),
    documentUri: readUrl(doc, 'document-uri'),
    sourceFile: readUrl(doc, 'source-file'),
    line: readLine(doc),
    disposition: readString(doc, 'disposition')?.slice(0, MAX_FIELD_CHARS),
  };
}
