import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CoverImageMediaType } from '../../src/images/generated';
import { readBaselineCaptureAuthorization } from './baseline';
import { loadComparisonBaseline, writeMixedComparisonReports } from './comparison';
import {
  captureBaselineRun,
  type BaselineGeneratedImageProvider,
  type BaselineProviderFactoryInput,
  type CoverQualificationCompiler,
} from './capture';

export interface CoverQualificationCliDependencies {
  repositoryRoot: string;
  now(): Date;
  logger: {
    info(message: string): void;
    error(message: string): void;
  };
  createProvider(input: BaselineProviderFactoryInput): BaselineGeneratedImageProvider;
  replacementCompiler?: CoverQualificationCompiler;
}

type AuthorizationGateReason = Exclude<
  ReturnType<typeof readBaselineCaptureAuthorization>,
  { authorized: true }
>['reason'];

export type CoverQualificationCliResult =
  | {
      status: 'gated';
      reason: AuthorizationGateReason | 'replacement_compiler_unavailable';
    }
  | {
      status: 'captured';
      outputDirectory: string;
      capturedArtifacts: number;
      failedArtifacts: number;
    };

function referenceMediaType(path: string): CoverImageMediaType {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  throw new Error('The controlled synthetic reference must be a JPEG, PNG, or WebP image.');
}

function defaultRunId(now: Date): string {
  return `replacement-${now
    .toISOString()
    .replaceAll(/[^0-9]/g, '')
    .slice(0, 14)}`;
}

export async function runCoverQualificationCli(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: CoverQualificationCliDependencies,
): Promise<CoverQualificationCliResult> {
  const authorization = readBaselineCaptureAuthorization(environment);
  if (!authorization.authorized) {
    const message = `Cover replacement qualification is gated (${authorization.reason}).`;
    if (authorization.reason === 'capture_not_enabled') dependencies.logger.info(message);
    else dependencies.logger.error(message);
    return { status: 'gated', reason: authorization.reason };
  }
  if (!dependencies.replacementCompiler) {
    dependencies.logger.error(
      'Cover capture is gated until the replacement planner compiler is explicitly composed.',
    );
    return { status: 'gated', reason: 'replacement_compiler_unavailable' };
  }

  const createdAt = dependencies.now();
  const runId = environment.COVER_MODEL_TEST_RUN_ID?.trim() || defaultRunId(createdAt);
  const defaultOutput = join(dependencies.repositoryRoot, 'data/cover-qualification/runs', runId);
  const outputDirectory = environment.COVER_MODEL_TEST_OUT?.trim()
    ? resolve(dependencies.repositoryRoot, environment.COVER_MODEL_TEST_OUT.trim())
    : defaultOutput;
  const comparisonBaseline = await loadComparisonBaseline(
    resolve(dependencies.repositoryRoot, environment.COVER_MODEL_TEST_BASELINE_RUN!),
  );
  const referencePath = environment.COVER_MODEL_TEST_REFERENCE?.trim();
  const syntheticReference = referencePath
    ? {
        mediaType: referenceMediaType(referencePath),
        bytes: new Uint8Array(await readFile(referencePath)),
      }
    : undefined;
  dependencies.logger.info(
    `Capturing ${authorization.expectedCallCount} controlled replacement artifacts across ${authorization.models.length} models.`,
  );
  const manifest = await captureBaselineRun(
    {
      authorization,
      apiKey: environment.IMAGE_API_KEY!,
      outputDirectory,
      runId,
      createdAt: createdAt.toISOString(),
      resolution: environment.IMAGE_RESOLUTION?.trim() || '1K',
      aspectRatio: environment.IMAGE_ASPECT_RATIO?.trim() || '1:1',
      supportedParams: [],
      ...(syntheticReference ? { syntheticReference } : {}),
    },
    {
      createProvider: dependencies.createProvider,
      replacementCompiler: dependencies.replacementCompiler,
      nowMs: Date.now,
    },
  );
  await writeMixedComparisonReports({
    baseline: comparisonBaseline,
    replacementDirectory: outputDirectory,
    replacementManifest: manifest,
  });
  dependencies.logger.info(`Replacement qualification artifacts written to ${outputDirectory}.`);
  return {
    status: 'captured',
    outputDirectory,
    capturedArtifacts: manifest.run.capturedArtifacts,
    failedArtifacts: manifest.run.failedArtifacts,
  };
}
