import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBaselineCases,
  completeQualificationCallCount,
  getBaselineFixtureCatalog,
} from './baseline';
import { BASELINE_SPEND_CONFIRMATION } from './baseline';
import { FROZEN_PRE_REPLACEMENT_RUN_ID } from './baseline';
import { runCoverQualificationCli } from './cli';
import { loadComparisonBaseline, writeMixedComparisonReports } from './comparison';
import {
  BASELINE_MANIFEST_SCHEMA_VERSION,
  type BaselineArtifact,
  type BaselineRunManifest,
} from './contracts';

const models = ['provider/model-a', 'provider/model-b'];

function manifest(kind: 'pre_replacement' | 'replacement', runId: string): BaselineRunManifest {
  const catalogText = `${JSON.stringify(getBaselineFixtureCatalog(), null, 2)}\n`;
  const cases = buildBaselineCases();
  const artifacts: BaselineArtifact[] = models.flatMap((model, modelIndex) =>
    cases.map((entry, caseIndex) => {
      const id = (modelIndex * cases.length + caseIndex + 1).toString(16).padStart(24, '0');
      return {
        id,
        fixtureId: entry.fixtureId,
        sessionVariant: entry.sessionVariant,
        controlledSessionId: entry.activitySessionId,
        requestedStyle: entry.requestedStyle,
        referenceMode: entry.referenceMode,
        provider: 'openrouter',
        model,
        capabilitySnapshotId: 'safe-capability-snapshot',
        prompt: { version: 'safe-version', sha256: 'a'.repeat(64) },
        safeAppliedControls: {
          candidateCount: 1,
          referencesApplied: entry.referenceMode === 'synthetic_person',
        },
        latencyMs: 10,
        technicalOutcome: 'captured',
        artifact: {
          relativePath: `images/${id}.webp`,
          sha256: 'b'.repeat(64),
          byteLength: 100,
          mediaType: 'image/webp',
        },
      };
    }),
  );
  return {
    schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
    baselineKind: kind,
    promptVersion: 'safe-version',
    dataClassification: 'controlled_synthetic_only',
    fixtureCatalog: {
      schemaVersion: 'session-cover-baseline-v1',
      relativePath: 'fixture-catalog.json',
      sha256: createHash('sha256').update(catalogText).digest('hex'),
    },
    run: {
      id: runId,
      createdAt: '2026-07-12T12:00:00.000Z',
      scope: 'complete',
      status: 'captured',
      expectedArtifacts: artifacts.length,
      capturedArtifacts: artifacts.length,
      failedArtifacts: 0,
      reportedTotalCostUsd: 1,
      reviewPasses: 2,
    },
    models: models.map((model) => ({
      provider: 'openrouter',
      model,
      capabilitySnapshot: { supportedParams: [], supportsReferences: true },
    })),
    artifacts,
  };
}

describe('blind replacement comparison', () => {
  it('mixes every baseline and replacement artifact into two identity-blind passes', async () => {
    const perRunArtifactCount = completeQualificationCallCount();
    const parent = await mkdtemp(join(tmpdir(), 'liedmotif-cover-comparison-'));
    const baselineDirectory = join(parent, 'baseline');
    const replacementDirectory = join(parent, 'replacement');
    await Promise.all([
      mkdir(join(baselineDirectory, 'images'), { recursive: true }),
      mkdir(join(replacementDirectory, 'images'), { recursive: true }),
    ]);
    await Promise.all(
      manifest('pre_replacement', 'baseline-run').artifacts.flatMap((artifact) => [
        writeFile(join(baselineDirectory, artifact.artifact!.relativePath), new Uint8Array([1])),
        writeFile(join(replacementDirectory, artifact.artifact!.relativePath), new Uint8Array([2])),
      ]),
    );
    await Promise.all([
      writeFile(
        join(baselineDirectory, 'manifest.json'),
        JSON.stringify(manifest('pre_replacement', FROZEN_PRE_REPLACEMENT_RUN_ID)),
      ),
      writeFile(
        join(baselineDirectory, 'fixture-catalog.json'),
        JSON.stringify(getBaselineFixtureCatalog()),
      ),
    ]);

    try {
      await writeMixedComparisonReports({
        baseline: await loadComparisonBaseline(baselineDirectory),
        replacementDirectory,
        replacementManifest: manifest('replacement', 'replacement-run'),
      });
      const [passOne, passTwo, comparisonText] = await Promise.all([
        readFile(join(replacementDirectory, 'review-pass-1.html'), 'utf8'),
        readFile(join(replacementDirectory, 'review-pass-2.html'), 'utf8'),
        readFile(join(replacementDirectory, 'comparison-manifest.json'), 'utf8'),
      ]);
      const ids = (html: string) =>
        [...html.matchAll(/data-blind-artifact="([a-f0-9]+)"/g)].map((match) => match[1]);
      const comparison = JSON.parse(comparisonText) as {
        comparisonSources: Record<string, { qualificationKind: string; model: string }>;
      };

      expect(ids(passOne)).toHaveLength(perRunArtifactCount * 2);
      expect(ids(passTwo)).toHaveLength(perRunArtifactCount * 2);
      expect(ids(passOne)).not.toEqual(ids(passTwo));
      expect(passOne).not.toContain('provider/model-a');
      expect(passOne).not.toContain('pre_replacement');
      expect(passOne).not.toContain('replacement-run');
      expect(Object.keys(comparison.comparisonSources)).toHaveLength(perRunArtifactCount * 2);
      expect(
        Object.values(comparison.comparisonSources).filter(
          (source) => source.qualificationKind === 'pre_replacement',
        ),
      ).toHaveLength(perRunArtifactCount);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('does not treat an operator capability assertion as reference-support proof', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'liedmotif-cover-capability-preflight-'));
    const baselineDirectory = join(parent, 'baseline');
    await mkdir(join(baselineDirectory, 'images'), { recursive: true });
    const referencePath = join(parent, 'synthetic.webp');
    const baselineManifest = manifest('pre_replacement', FROZEN_PRE_REPLACEMENT_RUN_ID);
    await Promise.all([
      writeFile(join(baselineDirectory, 'manifest.json'), JSON.stringify(baselineManifest)),
      writeFile(
        join(baselineDirectory, 'fixture-catalog.json'),
        JSON.stringify(getBaselineFixtureCatalog()),
      ),
      writeFile(referencePath, new Uint8Array([1])),
      ...baselineManifest.artifacts.map((artifact) =>
        writeFile(join(baselineDirectory, artifact.artifact!.relativePath), new Uint8Array([1])),
      ),
    ]);
    const factorySupportedParams: string[][] = [];
    let imageRequests = 0;

    try {
      await expect(
        runCoverQualificationCli(
          {
            COVER_MODEL_TEST: '1',
            COVER_MODEL_TEST_AUTHORIZE_SPEND: BASELINE_SPEND_CONFIRMATION,
            COVER_MODEL_TEST_MODELS: models.join(','),
            COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT: '1',
            COVER_MODEL_TEST_MAX_CALLS: String(completeQualificationCallCount()),
            COVER_MODEL_TEST_BASELINE_RUN: baselineDirectory,
            COVER_MODEL_TEST_REFERENCE: referencePath,
            COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC: '1',
            IMAGE_SUPPORTED_PARAMS: 'input_references',
            IMAGE_API_KEY: 'recording-only-key',
          },
          {
            repositoryRoot: parent,
            now: () => new Date('2026-07-12T12:00:00.000Z'),
            logger: { info() {}, error() {} },
            replacementCompiler: {
              planVersion: 'unused',
              promptVersion: 'unused',
              compile() {
                throw new Error('Compiler must not run before reference preflight.');
              },
              async finishArtifact() {
                throw new Error('Post-processing must not run before reference preflight.');
              },
            },
            createProvider(input) {
              factorySupportedParams.push([...input.supportedParams]);
              return {
                model: input.model,
                async getCapabilities() {
                  return {
                    provider: {
                      providerType: 'image',
                      providerKey: 'recording',
                      model: input.model,
                    },
                    exclusions: 'inline',
                    nativeSeed: false,
                    idempotency: 'absent',
                    references: null,
                    squareOutput: 'local_crop',
                    maxCandidates: 1,
                    costReporting: false,
                  } as const;
                },
                async generateCover() {
                  imageRequests += 1;
                  return { bytes: new Uint8Array([1]), mediaType: 'image/webp' as const };
                },
              };
            },
          },
        ),
      ).rejects.toThrow('Every selected model must support');
      expect(factorySupportedParams).toEqual([[], []]);
      expect(imageRequests).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
import { createHash } from 'node:crypto';
