import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import {
  buildBaselineCases,
  completeQualificationCallCount,
  FROZEN_PRE_REPLACEMENT_RUN_ID,
  getBaselineFixtureCatalog,
  QUALIFICATION_MODEL_COUNT,
  type BaselineFixtureCatalog,
} from './baseline';
import type { BaselineArtifact, BaselineRunManifest } from './contracts';
import { buildReviewOrders, renderBaselineReviewReport } from './report';

interface ComparisonSource {
  qualificationKind: 'pre_replacement' | 'replacement';
  originalArtifactId: string;
  model: string;
}

export interface LoadedComparisonBaseline {
  directory: string;
  manifest: BaselineRunManifest;
  catalog: BaselineFixtureCatalog;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function blindId(runId: string, kind: ComparisonSource['qualificationKind'], id: string): string {
  return createHash('sha256').update(`${runId}\0${kind}\0${id}`).digest('hex').slice(0, 24);
}

function isCompleteEvidence(manifest: BaselineRunManifest): boolean {
  const expected = completeQualificationCallCount();
  return (
    manifest.run.scope === 'complete' &&
    manifest.run.expectedArtifacts === expected &&
    manifest.artifacts.length === expected &&
    manifest.run.capturedArtifacts + manifest.run.failedArtifacts === expected
  );
}

function serializedCatalog(catalog: BaselineFixtureCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function hasExactMatrix(manifest: BaselineRunManifest): boolean {
  const models = [...new Set(manifest.models.map((entry) => entry.model))];
  if (
    models.length !== QUALIFICATION_MODEL_COUNT ||
    manifest.models.length !== QUALIFICATION_MODEL_COUNT
  ) {
    return false;
  }
  const expected = new Set(
    models.flatMap((model) =>
      buildBaselineCases().map(
        (entry) =>
          `${entry.fixtureId}\0${entry.sessionVariant}\0${entry.activitySessionId}\0${model}`,
      ),
    ),
  );
  const actual = new Set(
    manifest.artifacts.map(
      (artifact) =>
        `${artifact.fixtureId}\0${artifact.sessionVariant}\0${artifact.controlledSessionId}\0${artifact.model}`,
    ),
  );
  const completeSize = completeQualificationCallCount();
  return (
    actual.size === completeSize &&
    expected.size === completeSize &&
    [...expected].every((key) => actual.has(key))
  );
}

function safeArtifactPath(value: string): boolean {
  return /^images\/[a-f0-9]{16,64}\.(?:png|jpe?g|webp)$/i.test(value);
}

export async function loadComparisonBaseline(directory: string): Promise<LoadedComparisonBaseline> {
  const [manifestText, catalogText] = await Promise.all([
    readFile(join(directory, 'manifest.json'), 'utf8'),
    readFile(join(directory, 'fixture-catalog.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as BaselineRunManifest;
  const catalog = JSON.parse(catalogText) as BaselineFixtureCatalog;
  const catalogTextCanonical = serializedCatalog(catalog);
  const expectedCatalogText = serializedCatalog(getBaselineFixtureCatalog());
  const fixtureIds = new Set(catalog.fixtures?.map((fixture) => fixture.id));
  if (
    manifest.baselineKind !== 'pre_replacement' ||
    manifest.run.id !== FROZEN_PRE_REPLACEMENT_RUN_ID ||
    !isCompleteEvidence(manifest) ||
    !hasExactMatrix(manifest) ||
    catalog.dataClassification !== 'controlled_synthetic_only' ||
    catalog.fixtures?.length !== getBaselineFixtureCatalog().fixtures.length ||
    catalogTextCanonical !== expectedCatalogText ||
    createHash('sha256').update(catalogTextCanonical).digest('hex') !==
      manifest.fixtureCatalog.sha256 ||
    manifest.artifacts.some((artifact) => !fixtureIds.has(artifact.fixtureId)) ||
    manifest.artifacts.some(
      (artifact) => artifact.artifact && !safeArtifactPath(artifact.artifact.relativePath),
    )
  ) {
    throw new Error('The comparison baseline is not valid complete controlled evidence.');
  }
  await Promise.all(
    manifest.artifacts.flatMap((artifact) =>
      artifact.artifact ? [stat(resolve(directory, artifact.artifact.relativePath))] : [],
    ),
  );
  return { directory, manifest, catalog };
}

async function blindArtifacts(args: {
  runId: string;
  outputDirectory: string;
  sourceDirectory: string;
  kind: ComparisonSource['qualificationKind'];
  artifacts: readonly BaselineArtifact[];
  sources: Record<string, ComparisonSource>;
}): Promise<BaselineArtifact[]> {
  return Promise.all(
    args.artifacts.map(async (artifact) => {
      const id = blindId(args.runId, args.kind, artifact.id);
      args.sources[id] = {
        qualificationKind: args.kind,
        originalArtifactId: artifact.id,
        model: artifact.model,
      };
      const artifactPath = artifact.artifact?.relativePath;
      if (artifactPath) {
        await copyFile(
          resolve(args.sourceDirectory, artifactPath),
          join(args.outputDirectory, 'comparison-images', `${id}${extname(artifactPath)}`),
        );
      }
      return {
        ...artifact,
        id,
        ...(artifactPath
          ? {
              artifact: {
                ...artifact.artifact!,
                relativePath: `comparison-images/${id}${extname(artifactPath)}`,
              },
            }
          : {}),
      };
    }),
  );
}

export async function writeMixedComparisonReports(args: {
  baseline: LoadedComparisonBaseline;
  replacementDirectory: string;
  replacementManifest: BaselineRunManifest;
}): Promise<void> {
  if (
    args.replacementManifest.baselineKind !== 'replacement' ||
    !isCompleteEvidence(args.replacementManifest) ||
    !hasExactMatrix(args.replacementManifest)
  ) {
    throw new Error('Replacement output is not valid complete controlled evidence.');
  }
  const runId = `comparison-${createHash('sha256')
    .update(`${args.baseline.manifest.run.id}\0${args.replacementManifest.run.id}`)
    .digest('hex')
    .slice(0, 20)}`;
  const sources: Record<string, ComparisonSource> = {};
  await mkdir(join(args.replacementDirectory, 'comparison-images'), { recursive: true });
  const artifacts = [
    ...(await blindArtifacts({
      runId,
      outputDirectory: args.replacementDirectory,
      sourceDirectory: args.baseline.directory,
      kind: 'pre_replacement',
      artifacts: args.baseline.manifest.artifacts,
      sources,
    })),
    ...(await blindArtifacts({
      runId,
      outputDirectory: args.replacementDirectory,
      sourceDirectory: args.replacementDirectory,
      kind: 'replacement',
      artifacts: args.replacementManifest.artifacts,
      sources,
    })),
  ];
  const manifest: BaselineRunManifest = {
    ...args.replacementManifest,
    baselineKind: 'comparison',
    promptVersion: 'blind-comparison',
    run: {
      ...args.replacementManifest.run,
      id: runId,
      expectedArtifacts: 144,
      capturedArtifacts: artifacts.filter((artifact) => artifact.technicalOutcome === 'captured')
        .length,
      failedArtifacts: artifacts.filter((artifact) => artifact.technicalOutcome !== 'captured')
        .length,
      reportedTotalCostUsd: Number(
        (
          args.baseline.manifest.run.reportedTotalCostUsd +
          args.replacementManifest.run.reportedTotalCostUsd
        ).toFixed(6),
      ),
    },
    models: [...args.baseline.manifest.models, ...args.replacementManifest.models],
    artifacts,
  };
  const orders = buildReviewOrders(manifest);
  await Promise.all([
    writeFile(
      join(args.replacementDirectory, 'comparison-manifest.json'),
      json({ ...manifest, comparisonSources: sources }),
      'utf8',
    ),
    writeFile(
      join(args.replacementDirectory, 'review-pass-1.html'),
      renderBaselineReviewReport({
        manifest,
        catalog: args.baseline.catalog,
        reviewPass: 1,
        artifacts: orders.passOne,
      }),
      'utf8',
    ),
    writeFile(
      join(args.replacementDirectory, 'review-pass-2.html'),
      renderBaselineReviewReport({
        manifest,
        catalog: args.baseline.catalog,
        reviewPass: 2,
        artifacts: orders.passTwo,
      }),
      'utf8',
    ),
  ]);
}
