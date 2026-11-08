import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { GeneratedImageCapabilities } from '@liedmotif/providers';
import {
  BASELINE_SPEND_CONFIRMATION,
  buildBaselineCases,
  completeQualificationCallCount,
  readBaselineCaptureAuthorization,
} from '../../../packages/providers/scripts/cover-qualification/baseline';
import { captureBaselineRun } from '../../../packages/providers/scripts/cover-qualification/capture';
import { replacementQualificationCompiler } from './cover-qualification-composition';

function capabilities(model: string): GeneratedImageCapabilities {
  return {
    provider: { providerType: 'image', providerKey: 'recording', model },
    exclusions: 'native',
    nativeSeed: true,
    idempotency: 'absent',
    references: {
      roles: ['subject'],
      maxCount: 1,
      multiSubjectIdentity: false,
      mediaTypes: ['image/webp'],
    },
    squareOutput: 'native',
    maxCandidates: 1,
    costReporting: true,
  };
}

describe('replacement qualification harness', () => {
  // The timeout covers real sharp work, not provider latency: the dry run drives
  // the production finalizer once per matrix artifact (decode, normalize to
  // 1024², brand, re-encode), so it scales with the matrix and with the host.
  it('dry-runs the complete matrix exactly once with one candidate and no rerolls', async () => {
    const outputParent = await mkdtemp(join(tmpdir(), 'liedmotif-cover-replacement-dry-'));
    const outputDirectory = join(outputParent, 'run');
    const models = ['architecture-a/model-one', 'architecture-b/model-two'];
    const completeCallCount = completeQualificationCallCount();
    const authorization = readBaselineCaptureAuthorization({
      COVER_MODEL_TEST: '1',
      COVER_MODEL_TEST_AUTHORIZE_SPEND: BASELINE_SPEND_CONFIRMATION,
      COVER_MODEL_TEST_MODELS: models.join(','),
      COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT: '1',
      COVER_MODEL_TEST_MAX_CALLS: String(completeCallCount),
      COVER_MODEL_TEST_BASELINE_RUN: '/controlled/pre-replacement-run',
      COVER_MODEL_TEST_REFERENCE: '/controlled/synthetic-person.webp',
      COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC: '1',
      IMAGE_API_KEY: 'recording-only-key',
    });
    expect(authorization).toMatchObject({
      authorized: true,
      scope: 'complete',
      expectedCallCount: completeCallCount,
      maxCalls: completeCallCount,
      models,
    });
    if (!authorization.authorized) throw new Error('Complete dry run was not authorized.');

    const image = new Uint8Array(
      await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 3,
          background: { r: 35, g: 48, b: 72 },
        },
      })
        .composite([
          {
            input: Buffer.from(
              '<svg width="1024" height="1024"><circle cx="720" cy="480" r="260" fill="#d96c3f"/></svg>',
            ),
          },
        ])
        .webp()
        .toBuffer(),
    );
    const requests: Array<{ model: string; count: 1; idempotencyKey: string }> = [];

    try {
      const manifest = await captureBaselineRun(
        {
          authorization,
          apiKey: 'recording-only-key',
          outputDirectory,
          runId: 'replacement-complete-dry-run',
          createdAt: '2026-07-12T12:00:00.000Z',
          resolution: '1K',
          aspectRatio: '1:1',
          supportedParams: ['resolution', 'aspect_ratio', 'n', 'seed', 'input_references'],
          syntheticReference: { mediaType: 'image/webp', bytes: image },
        },
        {
          replacementCompiler: replacementQualificationCompiler,
          nowMs: () => 1_000,
          createProvider: ({ model }) => ({
            model,
            async getCapabilities() {
              return capabilities(model);
            },
            async generateCover({ count, idempotencyKey }) {
              requests.push({ model, count, idempotencyKey });
              return { bytes: image, mediaType: 'image/webp' };
            },
          }),
        },
      );

      expect(requests).toHaveLength(completeCallCount);
      expect(requests.every((request) => request.count === 1)).toBe(true);
      expect(new Set(requests.map((request) => request.idempotencyKey)).size).toBe(
        completeCallCount,
      );
      expect(
        models.every(
          (model) =>
            requests.filter((request) => request.model === model).length === completeCallCount / 2,
        ),
      ).toBe(true);
      expect(manifest).toMatchObject({
        baselineKind: 'replacement',
        promptVersion: 'session-cover-prompt-v12',
        run: {
          scope: 'complete',
          expectedArtifacts: completeCallCount,
          capturedArtifacts: completeCallCount,
          failedArtifacts: 0,
        },
      });
      expect(manifest.artifacts).toHaveLength(completeCallCount);
      expect(
        manifest.artifacts.every((artifact) => artifact.safeAppliedControls.candidateCount === 1),
      ).toBe(true);
      const posters = manifest.artifacts.filter(
        (artifact) => artifact.plan?.resolvedStyle === 'poster_art',
      );
      // Every explicitly requested Poster Art case resolves poster; Auto cases
      // may add more since poster_art sits in the Auto preset pool.
      const explicitPosterCount =
        buildBaselineCases().filter((entry) => entry.requestedStyle === 'poster_art').length *
        models.length;
      expect(posters.length).toBeGreaterThanOrEqual(explicitPosterCount);
      expect(
        manifest.artifacts.filter((artifact) => artifact.requestedStyle === 'poster_art'),
      ).toHaveLength(explicitPosterCount);
      expect(
        posters.every(
          (artifact) =>
            !artifact.safeAppliedControls.localPosterLettering &&
            artifact.artifact?.mediaType === 'image/webp' &&
            artifact.artifact.relativePath.endsWith('.webp'),
        ),
      ).toBe(true);
    } finally {
      await rm(outputParent, { recursive: true, force: true });
    }
  }, 60_000);
});
