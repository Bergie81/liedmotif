import type { BaselineCase } from '../../../packages/providers/scripts/cover-qualification/baseline';
import type { CoverQualificationCompiler } from '../../../packages/providers/scripts/cover-qualification/capture';
import {
  compileQualificationCoverPlan,
  finishQualificationCoverArtifact,
  QUALIFICATION_COVER_PLAN_VERSION,
  QUALIFICATION_COVER_PROMPT_VERSION,
} from '../src/session-cover/qualification-cover-plan';

function compileControlledCase(
  baselineCase: BaselineCase,
  capabilities: Parameters<CoverQualificationCompiler['compile']>[0]['capabilities'],
  referencesApplied: boolean,
) {
  return compileQualificationCoverPlan({
    sessionId: baselineCase.activitySessionId,
    sessionName: baselineCase.input.sessionTitle,
    coverConcept: null,
    coverStyle: baselineCase.requestedStyle,
    customDefinition:
      baselineCase.requestedStyle === 'custom' ? baselineCase.input.customStyleHint : null,
    sessionIntent: baselineCase.input.sessionIntent,
    snapshot: {
      stylePrompt: baselineCase.input.stylePrompt,
      mood: baselineCase.input.mood,
      activity: baselineCase.input.activity,
      energy: baselineCase.input.energy,
      genreTags: baselineCase.input.genreTags,
      vocalMode: 'instrumental',
    },
    capabilities,
    referencesApplied,
  });
}

export const replacementQualificationCompiler: CoverQualificationCompiler = {
  planVersion: QUALIFICATION_COVER_PLAN_VERSION,
  promptVersion: QUALIFICATION_COVER_PROMPT_VERSION,
  compile({ baselineCase, capabilities, referencesApplied }) {
    return compileControlledCase(baselineCase, capabilities, referencesApplied);
  },
  finishArtifact: finishQualificationCoverArtifact,
};
