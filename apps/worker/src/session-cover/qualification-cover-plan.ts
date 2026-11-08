import type { StyleSnapshot } from '@liedmotif/db';
import type { CoverImageMediaType, GeneratedImageCapabilities } from '@liedmotif/providers';
import type { CoverStyle } from '@liedmotif/shared';
import { createCoverArtworkFinalizer } from './cover-artwork-finalizer';
import {
  buildSessionCoverPlan,
  hashSessionCoverValue,
  SESSION_COVER_PLAN_VERSION,
  SESSION_COVER_PROMPT_VERSION,
} from './cover-plan';

export const QUALIFICATION_COVER_PLAN_VERSION = SESSION_COVER_PLAN_VERSION;
export const QUALIFICATION_COVER_PROMPT_VERSION = SESSION_COVER_PROMPT_VERSION;

/** Qualification must run the production finalizer, never a relaxed variant of it. */
const finalizer = createCoverArtworkFinalizer();

export interface QualificationCoverPlanInput {
  sessionId: string;
  sessionName: string;
  coverConcept: string | null;
  coverStyle: CoverStyle;
  customDefinition: string | null;
  sessionIntent: string | null;
  snapshot: StyleSnapshot;
  capabilities: GeneratedImageCapabilities;
  referencesApplied: boolean;
}

export interface QualificationCompiledCoverPlan {
  positivePrompt: string;
  exclusions: string[];
  seed: number;
  count: 1;
  planVersion: string;
  promptVersion: string;
  controlledFingerprint: string;
  resolvedStyle: string;
  poster: null;
}

export interface QualificationFinishedArtifact {
  bytes: Uint8Array;
  mediaType: CoverImageMediaType;
  localPosterLettering: boolean;
}

export function compileQualificationCoverPlan(
  input: QualificationCoverPlanInput,
): QualificationCompiledCoverPlan {
  const result = buildSessionCoverPlan({
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    coverConcept: input.coverConcept,
    coverStyle: input.coverStyle,
    customDefinition: input.customDefinition,
    snapshot: input.snapshot,
    sessionIntent: input.sessionIntent,
    capabilities: input.capabilities,
    referenceTreatment: input.referencesApplied ? 'controlled synthetic subject identity' : null,
  });
  if (!result.ok) {
    throw new Error(
      `Replacement Session Cover planner rejected controlled input: ${result.reason}`,
    );
  }
  return {
    positivePrompt: result.plan.prompt,
    exclusions: result.plan.exclusions,
    seed: result.seed,
    count: 1,
    planVersion: SESSION_COVER_PLAN_VERSION,
    promptVersion: SESSION_COVER_PROMPT_VERSION,
    controlledFingerprint: hashSessionCoverValue(result.fingerprint),
    resolvedStyle: result.plan.resolvedStyle,
    poster: null,
  };
}

export async function finishQualificationCoverArtifact(input: {
  compiled: QualificationCompiledCoverPlan;
  bytes: Uint8Array;
  mediaType: CoverImageMediaType;
}): Promise<QualificationFinishedArtifact> {
  const finished = await finalizer.finish({ bytes: input.bytes });
  if (!finished.ok) throw new Error(`Controlled qualification output rejected: ${finished.reason}`);
  return {
    bytes: finished.bytes,
    mediaType: finished.mediaType,
    localPosterLettering: false,
  };
}
