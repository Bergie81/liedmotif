import type {
  CoverImageMediaType,
  GeneratedImageCapabilities,
  GeneratedImageCapabilityDowngrade,
  GeneratedImageResult,
  OpenRouterImageParam,
} from '../../src/images/generated';
import type {
  BaselineCaptureAuthorization,
  BaselineCase,
  BaselineReferenceMode,
  BaselineRequestedStyle,
  BaselineSessionVariant,
} from './baseline';

export const BASELINE_MANIFEST_SCHEMA_VERSION = 'session-cover-baseline-manifest-v1';

export interface CoverReferenceInput {
  id: string;
  mediaType: CoverImageMediaType;
  bytes: Uint8Array;
}

export interface BaselineGeneratedImageResult {
  bytes: Uint8Array;
  mediaType: CoverImageMediaType;
  costUsd?: number;
  appliedControls?: GeneratedImageResult['appliedControls'];
  downgradeCodes?: GeneratedImageCapabilityDowngrade[];
}

export interface BaselineGeneratedImageProvider {
  model: string;
  getCapabilities(): Promise<GeneratedImageCapabilities>;
  generateCover(input: {
    prompt: string;
    exclusions: string[];
    seed: number;
    count: 1;
    idempotencyKey: string;
    references: CoverReferenceInput[];
  }): Promise<BaselineGeneratedImageResult>;
}

export interface BaselineProviderFactoryInput {
  apiKey: string;
  model: string;
  resolution: string;
  aspectRatio: string;
  supportedParams: readonly OpenRouterImageParam[];
}

export interface BaselineCaptureDependencies {
  createProvider(input: BaselineProviderFactoryInput): BaselineGeneratedImageProvider;
  replacementCompiler?: CoverQualificationCompiler;
  nowMs(): number;
}

export interface CoverQualificationCompiledPlan {
  positivePrompt: string;
  exclusions: string[];
  seed: number;
  count: 1;
  planVersion: string;
  promptVersion: string;
  controlledFingerprint: string;
  resolvedStyle: string;
  poster: { sessionName: string; safeArea: 'top' | 'bottom' } | null;
}

export interface CoverQualificationCompiler {
  planVersion: string;
  promptVersion: string;
  compile(input: {
    baselineCase: BaselineCase;
    referencesApplied: boolean;
    model: string;
    capabilities: GeneratedImageCapabilities;
  }): CoverQualificationCompiledPlan;
  finishArtifact(input: {
    compiled: CoverQualificationCompiledPlan;
    bytes: Uint8Array;
    mediaType: CoverImageMediaType;
  }): Promise<{
    bytes: Uint8Array;
    mediaType: CoverImageMediaType;
    localPosterLettering: boolean;
  }>;
}

export interface BaselineCaptureInput {
  authorization: Extract<BaselineCaptureAuthorization, { authorized: true }>;
  apiKey: string;
  outputDirectory: string;
  runId: string;
  createdAt: string;
  resolution: string;
  aspectRatio: string;
  supportedParams: readonly OpenRouterImageParam[];
  syntheticReference?: {
    mediaType: CoverImageMediaType;
    bytes: Uint8Array;
  };
}

export interface BaselineArtifact {
  id: string;
  fixtureId: string;
  sessionVariant: BaselineSessionVariant;
  controlledSessionId: string;
  requestedStyle: BaselineRequestedStyle;
  referenceMode: BaselineReferenceMode;
  provider: 'openrouter';
  model: string;
  capabilitySnapshotId: string;
  prompt: { version: string; sha256: string };
  safeAppliedControls: {
    resolution?: string;
    aspectRatio?: string;
    candidateCount: 1;
    referencesApplied: boolean;
    localPosterLettering?: boolean;
  };
  plan?: {
    version: string;
    controlledFingerprint: string;
    resolvedStyle: string;
  };
  capabilityDowngrades?: GeneratedImageCapabilityDowngrade[];
  latencyMs: number;
  reportedCostUsd?: number;
  technicalOutcome: 'captured' | 'provider_error' | 'technical_rejection' | 'artifact_write_error';
  failureCategory?:
    'sanitized_provider_error' | 'local_technical_rejection' | 'local_artifact_write_error';
  artifact?: {
    relativePath: string;
    sha256: string;
    byteLength: number;
    mediaType: CoverImageMediaType;
  };
}

export interface BaselineRunManifest {
  schemaVersion: typeof BASELINE_MANIFEST_SCHEMA_VERSION;
  baselineKind: 'pre_replacement' | 'replacement' | 'comparison';
  promptVersion: string;
  dataClassification: 'controlled_synthetic_only';
  fixtureCatalog: {
    schemaVersion: string;
    relativePath: 'fixture-catalog.json';
    sha256: string;
  };
  run: {
    id: string;
    createdAt: string;
    scope: 'complete' | 'partial';
    status: 'capturing' | 'captured' | 'captured_with_failures';
    expectedArtifacts: number;
    capturedArtifacts: number;
    failedArtifacts: number;
    reportedTotalCostUsd: number;
    reviewPasses: 2;
  };
  models: Array<{
    provider: 'openrouter';
    model: string;
    capabilitySnapshot:
      | GeneratedImageCapabilities
      | { supportedParams: OpenRouterImageParam[]; supportsReferences: boolean };
  }>;
  artifacts: BaselineArtifact[];
}
