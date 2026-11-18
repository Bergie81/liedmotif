import type { BaseProvider, ProviderMetadata } from '../types';

export const COVER_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type CoverImageMediaType = (typeof COVER_IMAGE_MEDIA_TYPES)[number];
export type GeneratedImageReferenceRole = 'subject' | 'style';

export interface GeneratedImageReference {
  id: string;
  role: GeneratedImageReferenceRole;
  mediaType: CoverImageMediaType;
  bytes: Uint8Array;
}

export interface GeneratedImageRequest {
  purpose: 'session-cover';
  positivePrompt: string;
  exclusions: string[];
  target: { shape: 'square'; quality: 'standard' | 'high' };
  references: GeneratedImageReference[];
  idempotencyKey: string;
  seed?: number;
  count: 1;
  /**
   * The completed music-generation task the cover derives from. Required by (and
   * only meaningful to) providers whose capabilities declare `musicTaskSource`;
   * prompt-driven providers ignore it.
   */
  musicTaskId?: string;
}

export interface GeneratedImageReferenceCapabilities {
  roles: GeneratedImageReferenceRole[];
  maxCount: number;
  /** True only when the selected endpoint explicitly preserves multiple subject identities. */
  multiSubjectIdentity: boolean;
  mediaTypes: CoverImageMediaType[];
  maxBytesPerReference?: number;
  maxTotalBytes?: number;
}

export interface GeneratedImageCapabilities {
  provider: Required<Pick<ProviderMetadata, 'providerType' | 'providerKey' | 'model'>>;
  maxPromptCharacters?: number;
  exclusions: 'native' | 'inline';
  nativeSeed: boolean;
  idempotency: 'native' | 'recoverable' | 'absent';
  references: GeneratedImageReferenceCapabilities | null;
  squareOutput: 'native' | 'local_crop';
  maxCandidates: number;
  costReporting: boolean;
  /**
   * Present when the provider derives covers from a completed music task of the
   * named music provider instead of the prompt (the prompt, exclusions,
   * references, and seed are ignored). Callers must supply
   * `GeneratedImageRequest.musicTaskId` and may only submit once such a task
   * exists.
   */
  musicTaskSource?: { musicProviderKey: string };
}

export type GeneratedImageCapabilityDowngrade =
  | 'capabilities_conservative'
  | 'exclusions_inlined'
  | 'square_requires_local_crop'
  | 'resolution_omitted'
  | 'quality_omitted'
  | 'candidate_count_omitted'
  | 'references_omitted'
  | 'seed_omitted'
  | 'idempotency_unavailable';

export interface GeneratedImageResult {
  provider: Required<Pick<ProviderMetadata, 'providerType' | 'providerKey' | 'model'>>;
  bytes: Uint8Array;
  mediaType: CoverImageMediaType;
  operationId?: string;
  reportedCostUsd?: number;
  appliedControls: {
    exclusions: 'native' | 'inline';
    square: 'native' | 'local_crop';
    references: number;
    seed: boolean;
    idempotency: 'native' | 'recoverable' | 'absent';
    candidateCount: 1;
  };
  downgradeCodes: GeneratedImageCapabilityDowngrade[];
}

/**
 * `account_not_ready`: the vendor refused image models for this account (no
 * billing, an unverified organisation) although the key itself is valid. It
 * never starts work, so it is never spend, and retrying cannot help until the
 * Admin fixes the account.
 */
export type GeneratedImageFailureKind =
  | 'configuration'
  | 'account_not_ready'
  | 'rate_limit'
  | 'unavailable'
  | 'timeout'
  | 'rejection'
  | 'invalid_response';

export type GeneratedImageSubmissionDisposition =
  'not_started' | 'retryable_with_same_key' | 'outcome_unknown';

const FAILURE_MESSAGES: Record<GeneratedImageFailureKind, string> = {
  configuration: 'Generated image provider configuration was rejected.',
  account_not_ready: 'Generated image provider account is not ready for images.',
  rate_limit: 'Generated image provider rate limit was reached.',
  unavailable: 'Generated image provider is unavailable.',
  timeout: 'Generated image request timed out.',
  rejection: 'Generated image request was rejected.',
  invalid_response: 'Generated image provider returned an invalid response.',
};

export class GeneratedImageProviderError extends Error {
  readonly kind: GeneratedImageFailureKind;
  readonly submissionDisposition: GeneratedImageSubmissionDisposition;

  constructor(
    kind: GeneratedImageFailureKind,
    submissionDisposition: GeneratedImageSubmissionDisposition,
  ) {
    super(FAILURE_MESSAGES[kind]);
    this.name = 'GeneratedImageProviderError';
    this.kind = kind;
    this.submissionDisposition = submissionDisposition;
  }
}

export interface GeneratedImageProvider extends BaseProvider {
  readonly providerType: 'image';
  readonly model: string;
  getCapabilities(): Promise<GeneratedImageCapabilities>;
  generate(request: GeneratedImageRequest): Promise<GeneratedImageResult>;
}
