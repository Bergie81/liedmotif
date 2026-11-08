import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CoverImageMediaType,
  GeneratedImageCapabilities,
  OpenRouterImageParam,
} from '../../src/images/generated';
import {
  buildBaselineCases,
  getBaselineFixtureCatalog,
  type BaselineCase,
  type BaselineFixtureCatalog,
  type BaselineReferenceMode,
} from './baseline';
import {
  BASELINE_MANIFEST_SCHEMA_VERSION,
  type BaselineArtifact,
  type BaselineCaptureDependencies,
  type BaselineCaptureInput,
  type BaselineGeneratedImageProvider,
  type BaselineGeneratedImageResult,
  type BaselineRunManifest,
  type CoverQualificationCompiledPlan,
  type CoverQualificationCompiler,
  type CoverReferenceInput,
} from './contracts';
import { buildReviewOrders, getBaselineRatingSchema, renderBaselineReviewReport } from './report';

export {
  BASELINE_MANIFEST_SCHEMA_VERSION,
  type BaselineArtifact,
  type BaselineCaptureDependencies,
  type BaselineCaptureInput,
  type BaselineGeneratedImageProvider,
  type BaselineProviderFactoryInput,
  type BaselineRunManifest,
  type CoverQualificationCompiledPlan,
  type CoverQualificationCompiler,
} from './contracts';

interface BaselineCaptureRun {
  input: BaselineCaptureInput;
  dependencies: BaselineCaptureDependencies;
  cases: BaselineCase[];
  providers: BaselineGeneratedImageProvider[];
  capabilitiesByModel: Map<string, GeneratedImageCapabilities>;
  catalog: BaselineFixtureCatalog;
  supportedParams: OpenRouterImageParam[];
  manifest: BaselineRunManifest;
  providerCallsAttempted: number;
}

type BaselineArtifactCommon = Omit<
  BaselineArtifact,
  'latencyMs' | 'technicalOutcome' | 'reportedCostUsd' | 'failureCategory' | 'artifact'
>;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function extension(mediaType: CoverImageMediaType): string {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  return 'png';
}

function safeRunId(runId: string): string {
  const normalized = runId.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(normalized)) {
    throw new Error(
      'Baseline run id must contain only letters, numbers, dots, dashes, or underscores.',
    );
  }
  return normalized;
}

function selectedCatalog(fixtureIds: readonly string[]): BaselineFixtureCatalog {
  const catalog = getBaselineFixtureCatalog();
  return {
    ...catalog,
    fixtures: catalog.fixtures.filter((fixture) => fixtureIds.includes(fixture.id)),
  };
}

function referenceInputs(
  referenceMode: BaselineReferenceMode,
  syntheticReference: BaselineCaptureInput['syntheticReference'],
): CoverReferenceInput[] {
  if (referenceMode === 'none') return [];
  if (!syntheticReference) {
    throw new Error(
      'The controlled synthetic reference is required by the selected fixture matrix.',
    );
  }
  return [
    {
      id: 'controlled-synthetic-identity',
      mediaType: syntheticReference.mediaType,
      bytes: syntheticReference.bytes,
    },
  ];
}

async function persistManifest(
  outputDirectory: string,
  manifest: BaselineRunManifest,
): Promise<void> {
  await writeFile(join(outputDirectory, 'manifest.json'), json(manifest), 'utf8');
}

async function createBaselineCaptureRun(
  input: BaselineCaptureInput,
  dependencies: BaselineCaptureDependencies,
): Promise<BaselineCaptureRun> {
  if (!dependencies.replacementCompiler) {
    throw new Error('Replacement qualification compiler is required.');
  }
  const runId = safeRunId(input.runId);
  const cases = buildBaselineCases(input.authorization.fixtureIds);
  if (cases.length * input.authorization.models.length !== input.authorization.expectedCallCount) {
    throw new Error('The authorized call count does not match the selected baseline matrix.');
  }
  if (!input.apiKey.trim()) throw new Error('The image-provider credential is required.');

  const needsReference = cases.some((entry) => entry.referenceMode === 'synthetic_person');
  if (needsReference && !input.syntheticReference) {
    throw new Error(
      'The controlled synthetic reference is required by the selected fixture matrix.',
    );
  }
  await mkdir(dirname(input.outputDirectory), { recursive: true });
  try {
    await mkdir(input.outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Baseline output directory must be new.', { cause: error });
    }
    throw error;
  }

  const providers = input.authorization.models.map((model) =>
    dependencies.createProvider({
      apiKey: input.apiKey,
      model,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
      supportedParams: input.supportedParams,
    }),
  );
  const capabilitiesByModel = new Map<string, GeneratedImageCapabilities>();
  for (const provider of providers) {
    capabilitiesByModel.set(provider.model, await provider.getCapabilities());
  }
  if (
    needsReference &&
    providers.some((provider) => {
      const references = capabilitiesByModel.get(provider.model)?.references;
      return !references || !references.roles.includes('subject') || references.maxCount < 1;
    })
  ) {
    throw new Error(
      'Every selected model must support the controlled synthetic reference fixture.',
    );
  }

  const catalog = selectedCatalog(input.authorization.fixtureIds);
  const serializedCatalog = json(catalog);
  const supportedParams = [...input.supportedParams].toSorted();
  const manifest: BaselineRunManifest = {
    schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
    baselineKind: 'replacement',
    promptVersion: dependencies.replacementCompiler.promptVersion,
    dataClassification: 'controlled_synthetic_only',
    fixtureCatalog: {
      schemaVersion: catalog.schemaVersion,
      relativePath: 'fixture-catalog.json',
      sha256: sha256(serializedCatalog),
    },
    run: {
      id: runId,
      createdAt: input.createdAt,
      scope: input.authorization.scope,
      status: 'capturing',
      expectedArtifacts: input.authorization.expectedCallCount,
      capturedArtifacts: 0,
      failedArtifacts: 0,
      reportedTotalCostUsd: 0,
      reviewPasses: 2,
    },
    models: providers.map((provider) => ({
      provider: 'openrouter',
      model: provider.model,
      capabilitySnapshot: capabilitiesByModel.get(provider.model)!,
    })),
    artifacts: [],
  };

  await mkdir(join(input.outputDirectory, 'images'), { recursive: true });
  await writeFile(join(input.outputDirectory, 'fixture-catalog.json'), serializedCatalog, 'utf8');
  await writeFile(
    join(input.outputDirectory, 'rating-schema.json'),
    json(getBaselineRatingSchema()),
    'utf8',
  );
  await persistManifest(input.outputDirectory, manifest);
  return {
    input,
    dependencies,
    cases,
    providers,
    capabilitiesByModel,
    catalog,
    supportedParams,
    manifest,
    providerCallsAttempted: 0,
  };
}

function artifactCommon(args: {
  run: BaselineCaptureRun;
  provider: BaselineGeneratedImageProvider;
  baselineCase: BaselineCase;
  references: CoverReferenceInput[];
  prompt: string;
  compiled: CoverQualificationCompiledPlan;
  capabilitySnapshotId: string;
}): BaselineArtifactCommon {
  const artifactId = sha256(
    `${args.run.manifest.run.id}\0${args.provider.model}\0${args.baselineCase.activitySessionId}`,
  ).slice(0, 24);
  return {
    id: artifactId,
    fixtureId: args.baselineCase.fixtureId,
    sessionVariant: args.baselineCase.sessionVariant,
    controlledSessionId: args.baselineCase.activitySessionId,
    requestedStyle: args.baselineCase.requestedStyle,
    referenceMode: args.baselineCase.referenceMode,
    provider: 'openrouter',
    model: args.provider.model,
    capabilitySnapshotId: args.capabilitySnapshotId,
    prompt: {
      version: args.compiled.promptVersion,
      sha256: sha256(args.prompt),
    },
    safeAppliedControls: {
      ...(args.run.supportedParams.includes('resolution')
        ? { resolution: args.run.input.resolution }
        : {}),
      ...(args.run.supportedParams.includes('aspect_ratio')
        ? { aspectRatio: args.run.input.aspectRatio }
        : {}),
      candidateCount: 1,
      referencesApplied: args.references.length > 0,
      localPosterLettering: false,
    },
    plan: {
      version: args.compiled.planVersion,
      controlledFingerprint: args.compiled.controlledFingerprint,
      resolvedStyle: args.compiled.resolvedStyle,
    },
    capabilityDowngrades: [],
  };
}

async function captureArtifact(args: {
  run: BaselineCaptureRun;
  provider: BaselineGeneratedImageProvider;
  baselineCase: BaselineCase;
  capabilitySnapshotId: string;
}): Promise<BaselineArtifact> {
  const references = referenceInputs(
    args.baselineCase.referenceMode,
    args.run.input.syntheticReference,
  );
  const compiler = args.run.dependencies.replacementCompiler;
  if (!compiler) throw new Error('Replacement qualification compiler is required.');
  const capabilities = args.run.capabilitiesByModel.get(args.provider.model);
  if (!capabilities) throw new Error('Selected model capabilities are unavailable.');
  const compiled = compiler.compile({
    baselineCase: args.baselineCase,
    referencesApplied: references.length > 0,
    model: args.provider.model,
    capabilities,
  });
  if (compiled.count !== 1 || !compiled.positivePrompt) {
    throw new Error('Replacement qualification compiler must request exactly one candidate.');
  }
  if (
    compiled.planVersion !== compiler.planVersion ||
    compiled.promptVersion !== compiler.promptVersion
  ) {
    throw new Error('Replacement qualification compiler version changed during the run.');
  }
  const prompt = compiled.positivePrompt;
  const common = artifactCommon({ ...args, references, prompt, compiled });
  const startedAt = args.run.dependencies.nowMs();
  let result: BaselineGeneratedImageResult;
  try {
    if (args.run.providerCallsAttempted >= args.run.input.authorization.maxCalls) {
      throw new Error('Authorized image-provider call ceiling reached.');
    }
    args.run.providerCallsAttempted += 1;
    result = await args.provider.generateCover({
      prompt,
      exclusions: compiled.exclusions,
      seed: compiled.seed,
      count: 1,
      idempotencyKey: common.id,
      references,
    });
  } catch {
    return {
      ...common,
      latencyMs: Math.max(0, args.run.dependencies.nowMs() - startedAt),
      technicalOutcome: 'provider_error',
      failureCategory: 'sanitized_provider_error',
    };
  }

  let finished: Awaited<ReturnType<CoverQualificationCompiler['finishArtifact']>>;
  try {
    finished = await compiler.finishArtifact({
      compiled,
      bytes: result.bytes,
      mediaType: result.mediaType,
    });
  } catch {
    return {
      ...common,
      latencyMs: Math.max(0, args.run.dependencies.nowMs() - startedAt),
      ...(result.costUsd === undefined ? {} : { reportedCostUsd: result.costUsd }),
      capabilityDowngrades: result.downgradeCodes ?? [],
      technicalOutcome: 'technical_rejection',
      failureCategory: 'local_technical_rejection',
    };
  }
  const relativePath = `images/${common.id}.${extension(finished.mediaType)}`;
  try {
    await writeFile(join(args.run.input.outputDirectory, relativePath), finished.bytes);
    return {
      ...common,
      safeAppliedControls: {
        ...common.safeAppliedControls,
        candidateCount: result.appliedControls?.candidateCount ?? 1,
        referencesApplied:
          result.appliedControls === undefined
            ? common.safeAppliedControls.referencesApplied
            : result.appliedControls.references > 0,
        localPosterLettering: finished.localPosterLettering,
      },
      capabilityDowngrades: result.downgradeCodes ?? [],
      latencyMs: Math.max(0, args.run.dependencies.nowMs() - startedAt),
      ...(result.costUsd === undefined ? {} : { reportedCostUsd: result.costUsd }),
      technicalOutcome: 'captured',
      artifact: {
        relativePath,
        sha256: sha256(finished.bytes),
        byteLength: finished.bytes.length,
        mediaType: finished.mediaType,
      },
    };
  } catch {
    return {
      ...common,
      latencyMs: Math.max(0, args.run.dependencies.nowMs() - startedAt),
      ...(result.costUsd === undefined ? {} : { reportedCostUsd: result.costUsd }),
      capabilityDowngrades: result.downgradeCodes ?? [],
      technicalOutcome: 'artifact_write_error',
      failureCategory: 'local_artifact_write_error',
    };
  }
}

async function recordArtifact(run: BaselineCaptureRun, artifact: BaselineArtifact): Promise<void> {
  run.manifest.artifacts.push(artifact);
  if (artifact.technicalOutcome === 'captured') run.manifest.run.capturedArtifacts += 1;
  else run.manifest.run.failedArtifacts += 1;
  if (artifact.reportedCostUsd !== undefined) {
    run.manifest.run.reportedTotalCostUsd = Number(
      (run.manifest.run.reportedTotalCostUsd + artifact.reportedCostUsd).toFixed(6),
    );
  }
  await persistManifest(run.input.outputDirectory, run.manifest);
}

async function captureProviderArtifacts(
  run: BaselineCaptureRun,
  provider: BaselineGeneratedImageProvider,
): Promise<void> {
  const capabilitySnapshotId = sha256(
    json({
      model: provider.model,
      supportedParams: run.supportedParams,
      capabilities: run.capabilitiesByModel.get(provider.model),
    }),
  );
  for (const baselineCase of run.cases) {
    const artifact = await captureArtifact({
      run,
      provider,
      baselineCase,
      capabilitySnapshotId,
    });
    await recordArtifact(run, artifact);
  }
}

async function finalizeBaselineCapture(run: BaselineCaptureRun): Promise<void> {
  const promptVersions = new Set(run.manifest.artifacts.map((artifact) => artifact.prompt.version));
  if (promptVersions.size !== 1) {
    throw new Error('Replacement qualification must use one prompt version for the full run.');
  }
  run.manifest.promptVersion = [...promptVersions][0]!;
  run.manifest.run.status =
    run.manifest.run.failedArtifacts > 0 ? 'captured_with_failures' : 'captured';
  const orders = buildReviewOrders(run.manifest);
  await writeFile(
    join(run.input.outputDirectory, 'review-pass-1.html'),
    renderBaselineReviewReport({
      manifest: run.manifest,
      catalog: run.catalog,
      reviewPass: 1,
      artifacts: orders.passOne,
    }),
    'utf8',
  );
  await writeFile(
    join(run.input.outputDirectory, 'review-pass-2.html'),
    renderBaselineReviewReport({
      manifest: run.manifest,
      catalog: run.catalog,
      reviewPass: 2,
      artifacts: orders.passTwo,
    }),
    'utf8',
  );
  await persistManifest(run.input.outputDirectory, run.manifest);
}

export async function captureBaselineRun(
  input: BaselineCaptureInput,
  dependencies: BaselineCaptureDependencies,
): Promise<BaselineRunManifest> {
  const run = await createBaselineCaptureRun(input, dependencies);
  for (const provider of run.providers) await captureProviderArtifacts(run, provider);
  if (run.providerCallsAttempted !== input.authorization.expectedCallCount) {
    throw new Error(
      'Replacement qualification did not execute the authorized matrix exactly once.',
    );
  }
  await finalizeBaselineCapture(run);
  return run.manifest;
}
