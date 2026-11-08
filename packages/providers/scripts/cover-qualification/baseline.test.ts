import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVER_STYLES } from '@liedmotif/shared';
import type { GeneratedImageCapabilities } from '../../src/images/generated';
import {
  BASELINE_SPEND_CONFIRMATION,
  completeQualificationCallCount,
  BASELINE_FIXTURE_CATALOG_VERSION,
  BASELINE_SESSION_VARIANTS,
  buildBaselineCases,
  getBaselineFixtureCatalog,
  readBaselineCaptureAuthorization,
} from './baseline';
import { captureBaselineRun } from './capture';
import { runCoverQualificationCli } from './cli';

function capabilities(model: string, supportsReferences = true): GeneratedImageCapabilities {
  return {
    provider: { providerType: 'image', providerKey: 'openrouter', model },
    exclusions: 'native',
    nativeSeed: true,
    idempotency: 'absent',
    references: supportsReferences
      ? {
          roles: ['subject'],
          maxCount: 1,
          multiSubjectIdentity: false,
          mediaTypes: ['image/webp'],
        }
      : null,
    squareOutput: 'native',
    maxCandidates: 1,
    costReporting: true,
  };
}

const recordingCompiler = {
  planVersion: 'session-cover-plan-v2',
  promptVersion: 'session-cover-prompt-v2',
  compile: ({ baselineCase }: { baselineCase: ReturnType<typeof buildBaselineCases>[number] }) => ({
    positivePrompt: `Controlled replacement prompt for ${baselineCase.input.sessionTitle}`,
    exclusions: ['readable text'],
    seed: 42,
    count: 1 as const,
    planVersion: 'session-cover-plan-v2',
    promptVersion: 'session-cover-prompt-v2',
    controlledFingerprint: 'a'.repeat(64),
    resolvedStyle: baselineCase.requestedStyle,
    poster: null,
  }),
  async finishArtifact(input: {
    bytes: Uint8Array;
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  }) {
    return { ...input, localPosterLettering: false };
  },
};

describe('pre-replacement Session Cover baseline', () => {
  it('defines the complete controlled matrix with three stable Session variants per fixture', () => {
    const catalog = getBaselineFixtureCatalog();
    const cases = buildBaselineCases();
    const coveredStyles = new Set(catalog.fixtures.map((fixture) => fixture.requestedStyle));
    const coveredScenarios = new Set(catalog.fixtures.flatMap((fixture) => fixture.scenarios));

    expect(BASELINE_FIXTURE_CATALOG_VERSION).toBe('session-cover-baseline-v5');
    expect(coveredStyles).toEqual(new Set([...COVER_STYLES, 'custom']));
    expect(
      [
        'structured_no_llm',
        'person_reference',
        'similar_sessions',
        'abstract_name',
        'literal_name',
        'long_name',
        'multilingual_unicode_name',
        'poster_text',
        'conflicting_custom_definition',
      ].every((scenario) => coveredScenarios.has(scenario)),
    ).toBe(true);
    expect(BASELINE_SESSION_VARIANTS).toEqual(['variation-a', 'variation-b', 'variation-c']);
    expect(cases).toHaveLength(catalog.fixtures.length * 3);

    for (const fixture of catalog.fixtures) {
      const fixtureCases = cases.filter((entry) => entry.fixtureId === fixture.id);
      expect(fixtureCases.map((entry) => entry.sessionVariant)).toEqual(BASELINE_SESSION_VARIANTS);
      expect(new Set(fixtureCases.map((entry) => entry.activitySessionId)).size).toBe(3);
      expect(new Set(fixtureCases.map((entry) => entry.input.sessionTitle))).toEqual(
        new Set([fixture.input.sessionTitle]),
      );
      expect(new Set(fixtureCases.map((entry) => entry.input.sessionIntent))).toEqual(
        new Set([fixture.input.sessionIntent]),
      );
    }
  });

  it('requires affirmative spend, two models, an explicit call ceiling, and a synthetic reference', () => {
    const completeCallCount = completeQualificationCallCount();
    const baseEnvironment = {
      COVER_MODEL_TEST: '1',
      COVER_MODEL_TEST_AUTHORIZE_SPEND: BASELINE_SPEND_CONFIRMATION,
      COVER_MODEL_TEST_MODELS: 'provider/model-a,provider/model-b',
      COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT: '1',
      COVER_MODEL_TEST_MAX_CALLS: String(completeCallCount),
      COVER_MODEL_TEST_BASELINE_RUN: '/controlled/pre-replacement-run',
      COVER_MODEL_TEST_REFERENCE: '/controlled/synthetic-person.webp',
      COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC: '1',
      IMAGE_API_KEY: 'test-only-secret-that-must-not-be-returned',
    };

    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_BASELINE_RUN: undefined,
      }),
    ).toEqual({ authorized: false, reason: 'comparison_baseline_missing' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT: undefined,
      }),
    ).toEqual({ authorized: false, reason: 'material_model_difference_unconfirmed' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_MODELS: 'provider/model-a,provider/model-b,provider/model-c',
      }),
    ).toEqual({ authorized: false, reason: 'two_models_required' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_FIXTURES: 'auto-structured-rain-desk',
      }),
    ).toEqual({ authorized: false, reason: 'partial_scope_not_allowed' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_AUTHORIZE_SPEND: undefined,
      }),
    ).toEqual({ authorized: false, reason: 'spend_not_confirmed' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_MAX_CALLS: String(completeCallCount + 1),
      }),
    ).toEqual({ authorized: false, reason: 'call_ceiling_mismatch' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_MODELS: 'provider/model-a',
      }),
    ).toEqual({ authorized: false, reason: 'two_models_required' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_MAX_CALLS: String(completeCallCount - 1),
      }),
    ).toEqual({ authorized: false, reason: 'call_ceiling_too_low' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_MAX_CALLS: `${completeCallCount}calls`,
      }),
    ).toEqual({ authorized: false, reason: 'call_ceiling_missing' });
    expect(
      readBaselineCaptureAuthorization({
        ...baseEnvironment,
        COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC: undefined,
      }),
    ).toEqual({ authorized: false, reason: 'synthetic_reference_not_confirmed' });

    const authorized = readBaselineCaptureAuthorization(baseEnvironment);
    expect(authorized).toEqual({
      authorized: true,
      fixtureIds: getBaselineFixtureCatalog().fixtures.map((fixture) => fixture.id),
      models: ['provider/model-a', 'provider/model-b'],
      expectedCallCount: completeCallCount,
      maxCalls: completeCallCount,
      scope: 'complete',
    });
    expect(JSON.stringify(authorized)).not.toContain(baseEnvironment.IMAGE_API_KEY);
    expect(JSON.stringify(authorized)).not.toContain(baseEnvironment.COVER_MODEL_TEST_REFERENCE);
  });

  it('captures safe manifests and two independently randomized rating reports through a recording adapter', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'liedmotif-cover-baseline-'));
    const outputDirectory = join(temporaryDirectory, 'run');
    const apiKey = 'private-api-key-marker';
    const privateReferenceMarker = new TextEncoder().encode('PRIVATE-REFERENCE-BYTES');
    const fixtureIds = ['auto-structured-rain-desk', 'custom-conflict-paper-constellation'];
    const models = ['provider/model-a', 'provider/model-b'];
    const authorization = {
      authorized: true as const,
      fixtureIds,
      models,
      expectedCallCount: 12,
      maxCalls: 12,
      scope: 'partial' as const,
    };

    const receivedPrompts: string[] = [];
    let now = 1_000;
    try {
      const manifest = await captureBaselineRun(
        {
          authorization,
          apiKey,
          outputDirectory,
          runId: 'baseline-test-run',
          createdAt: '2026-07-12T12:00:00.000Z',
          resolution: '1K',
          aspectRatio: '1:1',
          supportedParams: ['resolution', 'aspect_ratio', 'n', 'input_references'],
          syntheticReference: {
            mediaType: 'image/webp',
            bytes: privateReferenceMarker,
          },
        },
        {
          replacementCompiler: recordingCompiler,
          nowMs: () => {
            now += 10;
            return now;
          },
          createProvider: ({ model }) => ({
            model,
            async getCapabilities() {
              return capabilities(model);
            },
            async generateCover({ prompt }) {
              receivedPrompts.push(prompt);
              return {
                bytes: new Uint8Array([1, 2, 3, 4]),
                mediaType: 'image/png',
                costUsd: 0.012,
              };
            },
          }),
        },
      );

      expect(receivedPrompts).toHaveLength(12);
      expect(manifest).toMatchObject({
        schemaVersion: 'session-cover-baseline-manifest-v1',
        baselineKind: 'replacement',
        promptVersion: 'session-cover-prompt-v2',
        run: {
          id: 'baseline-test-run',
          scope: 'partial',
          status: 'captured',
          expectedArtifacts: 12,
          capturedArtifacts: 12,
          failedArtifacts: 0,
        },
      });
      expect(manifest.artifacts).toHaveLength(12);
      expect(manifest.artifacts[0]).toMatchObject({
        provider: 'openrouter',
        model: 'provider/model-a',
        prompt: { version: 'session-cover-prompt-v2' },
        safeAppliedControls: {
          resolution: '1K',
          aspectRatio: '1:1',
          candidateCount: 1,
          referencesApplied: false,
          localPosterLettering: false,
        },
        plan: {
          version: 'session-cover-plan-v2',
          controlledFingerprint: 'a'.repeat(64),
        },
        latencyMs: 10,
        reportedCostUsd: 0.012,
        technicalOutcome: 'captured',
        artifact: {
          sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
          byteLength: 4,
          mediaType: 'image/png',
        },
      });
      expect(manifest.models).toMatchObject([
        { provider: 'openrouter', model: 'provider/model-a' },
        { provider: 'openrouter', model: 'provider/model-b' },
      ]);

      const serializedManifest = await readFile(join(outputDirectory, 'manifest.json'), 'utf8');
      const catalog = await readFile(join(outputDirectory, 'fixture-catalog.json'), 'utf8');
      const passOne = await readFile(join(outputDirectory, 'review-pass-1.html'), 'utf8');
      const passTwo = await readFile(join(outputDirectory, 'review-pass-2.html'), 'utf8');
      const passOneOrder = [...passOne.matchAll(/data-blind-artifact="([a-f0-9]+)"/g)].map(
        (match) => match[1],
      );
      const passTwoOrder = [...passTwo.matchAll(/data-blind-artifact="([a-f0-9]+)"/g)].map(
        (match) => match[1],
      );

      expect(JSON.parse(catalog)).toMatchObject({
        schemaVersion: BASELINE_FIXTURE_CATALOG_VERSION,
        dataClassification: 'controlled_synthetic_only',
      });
      expect(serializedManifest).not.toContain(apiKey);
      expect(serializedManifest).not.toContain('PRIVATE-REFERENCE-BYTES');
      expect(serializedManifest).not.toContain(receivedPrompts[0]!);
      expect(passOne).not.toContain('provider/model-a');
      expect(passOne).not.toContain('openrouter');
      expect(passOneOrder).toHaveLength(12);
      expect(passTwoOrder).toHaveLength(12);
      expect(passOneOrder).not.toEqual(passTwoOrder);
      expect(passOne).toContain('name="sessionNameAlignment"');
      expect(passOne).toContain('name="styleAdherence"');
      expect(passOne).toContain('name="distinctness"');
      expect(passOne).toContain('name="thumbnailReadability"');
      expect(passOne).toContain('name="referenceIntegration"');
      expect(passOne).toContain('name="unwantedTextLogos"');
      expect(passOne).toContain('name="visualCliches"');
      expect(passOne).toContain('Export ratings JSON');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing run directory before making an image request', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'liedmotif-cover-baseline-existing-'));
    const authorization = {
      authorized: true as const,
      fixtureIds: ['auto-structured-rain-desk'],
      models: ['provider/model-a', 'provider/model-b'],
      expectedCallCount: 6,
      maxCalls: 6,
      scope: 'partial' as const,
    };
    let imageRequests = 0;

    try {
      await expect(
        captureBaselineRun(
          {
            authorization,
            apiKey: 'test-key',
            outputDirectory,
            runId: 'existing-run',
            createdAt: '2026-07-12T12:00:00.000Z',
            resolution: '1K',
            aspectRatio: '1:1',
            supportedParams: ['resolution', 'aspect_ratio', 'n'],
          },
          {
            replacementCompiler: recordingCompiler,
            nowMs: Date.now,
            createProvider: ({ model }) => ({
              model,
              async getCapabilities() {
                return capabilities(model, false);
              },
              async generateCover() {
                imageRequests += 1;
                return { bytes: new Uint8Array([1]), mediaType: 'image/png' };
              },
            }),
          },
        ),
      ).rejects.toThrow('Baseline output directory must be new');
      expect(imageRequests).toBe(0);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('exits before constructing a provider when both paid-capture gates are not satisfied', async () => {
    let providerConstructions = 0;
    const result = await runCoverQualificationCli(
      {
        COVER_MODEL_TEST: '1',
        IMAGE_API_KEY: 'would-be-secret',
        COVER_MODEL_TEST_MODELS: 'provider/model-a,provider/model-b',
        COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT: '1',
      },
      {
        repositoryRoot: '/unused',
        now: () => new Date('2026-07-12T12:00:00.000Z'),
        logger: { info() {}, error() {} },
        createProvider() {
          providerConstructions += 1;
          throw new Error('Provider must not be constructed');
        },
      },
    );

    expect(result).toEqual({ status: 'gated', reason: 'spend_not_confirmed' });
    expect(providerConstructions).toBe(0);
  });

  it('fails closed before constructing a provider when no replacement compiler is composed', async () => {
    let providerConstructions = 0;
    const result = await runCoverQualificationCli(
      {
        COVER_MODEL_TEST: '1',
        COVER_MODEL_TEST_AUTHORIZE_SPEND: BASELINE_SPEND_CONFIRMATION,
        COVER_MODEL_TEST_MODELS: 'provider/model-a,provider/model-b',
        COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT: '1',
        COVER_MODEL_TEST_MAX_CALLS: String(completeQualificationCallCount()),
        COVER_MODEL_TEST_BASELINE_RUN: '/unused/pre-replacement-run',
        COVER_MODEL_TEST_REFERENCE: '/unused/synthetic-person.webp',
        COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC: '1',
        IMAGE_API_KEY: 'would-be-secret',
      },
      {
        repositoryRoot: '/unused',
        now: () => new Date('2026-07-12T12:00:00.000Z'),
        logger: { info() {}, error() {} },
        createProvider() {
          providerConstructions += 1;
          throw new Error('Provider must not be constructed');
        },
      },
    );

    expect(result).toEqual({
      status: 'gated',
      reason: 'replacement_compiler_unavailable',
    });
    expect(providerConstructions).toBe(0);
  });
});
