// Sanitized provider errors. Their messages are SAFE to surface to a user and to
// log — they never carry a secret, a signed URL, or a raw provider error body.
// Adapters catch vendor/SDK errors and rethrow one of these instead.

export class ProviderError extends Error {
  /**
   * Non-secret diagnostic fields (error name, HTTP status, timeout flag, …) the
   * caller may log through the redacting logger. Never carries a provider
   * response body, a prompt, or a secret — adapters populate it only with
   * fields that are safe by construction.
   */
  readonly safeDetail?: Record<string, unknown>;

  constructor(message: string, safeDetail?: Record<string, unknown>) {
    super(message);
    this.name = 'ProviderError';
    this.safeDetail = safeDetail;
  }
}

/**
 * A failure that provably happened WITHOUT the provider charging for it: either
 * the adapter refused the input before any outbound call, or the provider
 * answered with a complete, well-formed rejection that created no task. The
 * money path parks these as failed-but-unbilled, so a provider outage or a bad
 * credential cannot burn a whole budget window with zero tracks.
 *
 * Adapters throw this ONLY when "nothing was charged" is provable. Anything
 * ambiguous — a timeout, a 5xx, a dropped connection, an unparseable body —
 * stays a plain `ProviderError` and keeps counting as spend.
 */
export class ProviderUnbilledError extends ProviderError {
  /**
   * Set when the provider refused for a reason that clears without any change
   * to the request — out of credits, unavailable (maintenance), or rate
   * limited — so the caller can wait it out instead of treating the request
   * as refused.
   */
  readonly refusal?: UnbilledRefusal;

  constructor(message: string, safeDetail?: Record<string, unknown>, refusal?: UnbilledRefusal) {
    super(message, safeDetail);
    this.name = 'ProviderUnbilledError';
    this.refusal = refusal;
  }
}

/** Why a provider refused a call that it would accept, unchanged, later. */
export type UnbilledRefusal = 'insufficient_credit' | 'provider_unavailable' | 'rate_limited';

/**
 * A configuration / SSRF rejection (e.g. a base URL pointing at a private host).
 * Unbilled by construction: adapters validate configuration and input before
 * issuing any outbound call, so this is always thrown with no request in flight.
 */
export class ProviderConfigError extends ProviderUnbilledError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** A provider-RETURNED URL (stream/final media) rejected by the egress guard. */
export class ProviderEgressError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderEgressError';
  }
}

/**
 * A mail that could not be sent. It carries the SMTP failure code (`EAUTH`,
 * `ECONNECTION`, `ETIMEDOUT`, …) and nothing else: a mail server's reply can
 * echo the recipient, a connection error the host, and the message itself holds
 * a one-shot link — none of which may reach a log.
 */
export class EmailSendError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`email could not be sent (${code})`);
    this.name = 'EmailSendError';
    this.code = code;
  }
}
