import { describe, expect, it } from 'vitest';
import {
  getBaselineFixtureCatalog,
  type BaselineFixture,
  type BaselineFixtureCatalog,
} from './baseline';
import {
  BASELINE_MANIFEST_SCHEMA_VERSION,
  type BaselineArtifact,
  type BaselineRunManifest,
} from './capture';
import { renderBaselineReviewReport } from './report';

function fixture(id: string): BaselineFixture {
  const match = getBaselineFixtureCatalog().fixtures.find((entry) => entry.id === id);
  if (!match) throw new Error(`Missing controlled fixture ${id}`);
  return match;
}

function reportFor(controlledFixture: BaselineFixture): string {
  const artifact: BaselineArtifact = {
    id: '0123456789abcdef01234567',
    fixtureId: controlledFixture.id,
    sessionVariant: 'variation-a',
    controlledSessionId: `cover-baseline-${controlledFixture.id}-variation-a`,
    requestedStyle: controlledFixture.requestedStyle,
    referenceMode: controlledFixture.referenceMode,
    provider: 'openrouter',
    model: 'private-model-identity',
    capabilitySnapshotId: 'capability-snapshot',
    prompt: { version: 'cover-brief-v2', sha256: 'prompt-hash' },
    safeAppliedControls: { candidateCount: 1, referencesApplied: false },
    latencyMs: 10,
    technicalOutcome: 'captured',
    artifact: {
      relativePath: 'images/0123456789abcdef01234567.png',
      sha256: 'artifact-hash',
      byteLength: 4,
      mediaType: 'image/png',
    },
  };
  const catalog: BaselineFixtureCatalog = {
    schemaVersion: 'session-cover-baseline-v5',
    dataClassification: 'controlled_synthetic_only',
    fixtures: [controlledFixture],
  };
  const manifest: BaselineRunManifest = {
    schemaVersion: BASELINE_MANIFEST_SCHEMA_VERSION,
    baselineKind: 'pre_replacement',
    promptVersion: 'cover-brief-v2',
    dataClassification: 'controlled_synthetic_only',
    fixtureCatalog: {
      schemaVersion: catalog.schemaVersion,
      relativePath: 'fixture-catalog.json',
      sha256: 'catalog-hash',
    },
    run: {
      id: 'review-test',
      createdAt: '2026-07-12T12:00:00.000Z',
      scope: 'partial',
      status: 'captured',
      expectedArtifacts: 1,
      capturedArtifacts: 1,
      failedArtifacts: 0,
      reportedTotalCostUsd: 0,
      reviewPasses: 2,
    },
    models: [
      {
        provider: 'openrouter',
        model: 'private-model-identity',
        capabilitySnapshot: { supportedParams: [], supportsReferences: false },
      },
    ],
    artifacts: [artifact],
  };
  return renderBaselineReviewReport({
    manifest,
    catalog,
    reviewPass: 1,
    artifacts: [artifact],
  });
}

describe('Session Cover baseline review report', () => {
  it('shows the controlled Custom definition and HTML-escapes it', () => {
    const custom = fixture('custom-conflict-paper-constellation');
    const unsafeDefinition = `paper <script>alert("x")</script> & "ink" 'cuts'`;
    const html = reportFor({
      ...custom,
      input: { ...custom.input, customStyleHint: unsafeDefinition },
    });

    expect(html).toContain('<strong>Custom definition:</strong>');
    expect(html).toContain(
      'paper &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;ink&quot; &#39;cuts&#39;',
    );
    expect(html).not.toContain(unsafeDefinition);
    expect(html).not.toContain('private-model-identity');
  });

  it('omits Custom definition text from non-Custom and empty-Custom cards', () => {
    const auto = fixture('auto-structured-rain-desk');
    const custom = fixture('custom-conflict-paper-constellation');
    const nonCustomHtml = reportFor({
      ...auto,
      input: { ...auto.input, customStyleHint: 'must-not-appear' },
    });
    const emptyCustomHtml = reportFor({
      ...custom,
      input: { ...custom.input, customStyleHint: '   ' },
    });

    expect(nonCustomHtml).not.toContain('Custom definition:');
    expect(nonCustomHtml).not.toContain('must-not-appear');
    expect(emptyCustomHtml).not.toContain('Custom definition:');
  });

  it('scores style-compatible reference treatment without implying source-image comparison', () => {
    const custom = fixture('custom-conflict-paper-constellation');
    const html = reportFor(custom);

    expect(html).toContain('natural, style-compatible treatment');
    expect(html).not.toContain('recognizable use');
  });
});
