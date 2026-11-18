import {
  GeneratedImageProviderError,
  type GeneratedImageCapabilities,
  type GeneratedImageFailureKind,
  type GeneratedImageSubmissionDisposition,
} from '@liedmotif/providers';

export interface CoverSubmissionFailure {
  /** `null` when the provider threw outside the generated-image contract. */
  kind: GeneratedImageFailureKind | null;
  disposition: GeneratedImageSubmissionDisposition;
  /** The ledger's safe-retry counter after accounting for this failure. */
  safeRetryCount: number;
  retry: boolean;
}

/** A refusal no resend can turn into a Cover: the provider rejected the request or the account. */
export function isTerminalRejection(kind: GeneratedImageFailureKind | null): boolean {
  return kind === 'configuration' || kind === 'account_not_ready' || kind === 'rejection';
}

/**
 * Every paid image request is money, so a failed submission may only be resent under the
 * *same* idempotency key: a rejected/misconfigured request will never succeed, and an
 * ambiguous outcome can only be replayed safely when the provider deduplicates the key.
 */
export function classifyCoverSubmissionFailure(
  error: unknown,
  ledger: { safeRetryCount: number; maxSafeRetries: number },
  idempotency: GeneratedImageCapabilities['idempotency'],
): CoverSubmissionFailure {
  const known = error instanceof GeneratedImageProviderError ? error : null;
  const disposition = known?.submissionDisposition ?? 'outcome_unknown';
  const sameKeySafe =
    !isTerminalRejection(known?.kind ?? null) &&
    (disposition === 'not_started' ||
      (idempotency !== 'absent' &&
        (disposition === 'retryable_with_same_key' || disposition === 'outcome_unknown')));
  const safeRetryCount = ledger.safeRetryCount + (sameKeySafe ? 1 : 0);
  return {
    kind: known?.kind ?? null,
    disposition,
    safeRetryCount,
    retry: sameKeySafe && safeRetryCount <= ledger.maxSafeRetries,
  };
}
