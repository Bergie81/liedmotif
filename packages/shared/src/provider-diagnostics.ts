import { createRedactor, DEFAULT_SENSITIVE_KEY_FRAGMENTS } from './logger';

declare const redactedJsonBrand: unique symbol;

/** JSON proven to have passed through the provider-diagnostics redactor. */
export type RedactedJson = unknown & { readonly [redactedJsonBrand]: never };

/** Redacted, persistence-safe raw provider I/O, kept only for diagnostics. */
export interface ProviderDiagnostics {
  rawRequest?: RedactedJson;
  rawResponse?: RedactedJson;
}

const DIAGNOSTIC_KEY_FRAGMENTS = DEFAULT_SENSITIVE_KEY_FRAGMENTS.filter(
  (fragment) => fragment !== 'prompt',
);

const redactor = createRedactor({ sensitiveKeyFragments: DIAGNOSTIC_KEY_FRAGMENTS });

/** Redact a raw provider payload for safe logging or persistence. */
export function redactProviderDiagnostics(value: unknown): unknown {
  return redactor(value);
}

/** The only supported constructor for branded, persistence-safe diagnostics. */
export function buildProviderDiagnostics(raw: {
  rawRequest?: unknown;
  rawResponse?: unknown;
}): ProviderDiagnostics {
  return {
    ...(raw.rawRequest !== undefined
      ? { rawRequest: redactor(raw.rawRequest) as RedactedJson }
      : {}),
    ...(raw.rawResponse !== undefined
      ? { rawResponse: redactor(raw.rawResponse) as RedactedJson }
      : {}),
  };
}
