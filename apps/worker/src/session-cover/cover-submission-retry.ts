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
  const terminalRejection = known?.kind === 'configuration' || known?.kind === 'rejection';
  const sameKeySafe =
    !terminalRejection &&
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
