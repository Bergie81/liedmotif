import { createHash } from 'node:crypto';
import type { BaselineFixtureCatalog } from './baseline';
import type { BaselineArtifact, BaselineRunManifest } from './capture';

export const BASELINE_RATING_SCHEMA_VERSION = 'session-cover-baseline-ratings-v1';

const RATING_FIELDS = [
  {
    name: 'sessionNameAlignment',
    label: 'Session Name alignment',
    help: '1 = unrelated; 5 = a clear visual interpretation of the exact Name.',
  },
  {
    name: 'styleAdherence',
    label: 'Style adherence',
    help: '1 = wrong style; 5 = unmistakably follows the requested style.',
  },
  {
    name: 'distinctness',
    label: 'Distinctness',
    help: '1 = near duplicate; 5 = clearly distinct from related covers.',
  },
  {
    name: 'thumbnailReadability',
    label: 'Thumbnail readability',
    help: '1 = no legible hierarchy; 5 = immediate focal hierarchy at small size.',
  },
  {
    name: 'referenceIntegration',
    label: 'Reference integration',
    help: 'For reference fixtures: 1 = forced or awkward treatment; 5 = natural, style-compatible treatment.',
  },
  {
    name: 'unwantedTextLogos',
    label: 'Absence of unwanted text/logos',
    help: '1 = severe unwanted lettering/logo; 5 = none.',
  },
  {
    name: 'visualCliches',
    label: 'Absence of visual clichés',
    help: '1 = dominated by clichés; 5 = specific and fresh.',
  },
] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderRatingField(
  field: (typeof RATING_FIELDS)[number],
  referenceApplicable: boolean,
): string {
  const allowNotApplicable = field.name === 'referenceIntegration' && !referenceApplicable;
  const options = [
    `<option value="">Choose…</option>`,
    ...(allowNotApplicable ? [`<option value="na">N/A</option>`] : []),
    ...[1, 2, 3, 4, 5].map((rating) => `<option value="${rating}">${rating}</option>`),
  ].join('');
  return `<label><span>${escapeHtml(field.label)}</span><small>${escapeHtml(field.help)}</small><select name="${field.name}"${allowNotApplicable ? ' data-optional="true"' : ''}>${options}</select></label>`;
}

function randomizedArtifacts(manifest: BaselineRunManifest, reviewPass: 1 | 2): BaselineArtifact[] {
  return manifest.artifacts
    .filter((artifact) => artifact.technicalOutcome === 'captured')
    .toSorted((left, right) =>
      sha256(`${manifest.run.id}:pass-${reviewPass}:${left.id}`).localeCompare(
        sha256(`${manifest.run.id}:pass-${reviewPass}:${right.id}`),
      ),
    );
}

export function buildReviewOrders(manifest: BaselineRunManifest): {
  passOne: BaselineArtifact[];
  passTwo: BaselineArtifact[];
} {
  const passOne = randomizedArtifacts(manifest, 1);
  let passTwo = randomizedArtifacts(manifest, 2);
  if (
    passOne.length > 1 &&
    passOne.every((artifact, index) => artifact.id === passTwo[index]?.id)
  ) {
    passTwo = passTwo.toReversed();
  }
  return { passOne, passTwo };
}

export function renderBaselineReviewReport(args: {
  manifest: BaselineRunManifest;
  catalog: BaselineFixtureCatalog;
  reviewPass: 1 | 2;
  artifacts: readonly BaselineArtifact[];
}): string {
  const fixtures = new Map(args.catalog.fixtures.map((fixture) => [fixture.id, fixture]));
  const cards = args.artifacts
    .map((artifact, index) => {
      const fixture = fixtures.get(artifact.fixtureId);
      if (!fixture || !artifact.artifact) return '';
      const blindCode = `P${args.reviewPass}-${String(index + 1).padStart(3, '0')}`;
      const ratingFields = RATING_FIELDS.map((field) =>
        renderRatingField(field, fixture.referenceMode === 'synthetic_person'),
      ).join('');
      const customDefinition =
        fixture.requestedStyle === 'custom' ? fixture.input.customStyleHint.trim() : '';
      const customDefinitionMarkup = customDefinition
        ? `<p><strong>Custom definition:</strong> ${escapeHtml(customDefinition)}</p>`
        : '';
      return `<article class="card" data-blind-artifact="${artifact.id}" data-blind-code="${blindCode}" data-reference-applicable="${fixture.referenceMode === 'synthetic_person' ? 'true' : 'false'}">
  <header><strong>${blindCode}</strong><span>${escapeHtml(fixture.requestedStyle)}</span></header>
  <img src="${escapeHtml(artifact.artifact.relativePath)}" alt="Controlled baseline cover for ${escapeHtml(fixture.input.sessionTitle)}">
  <h2>${escapeHtml(fixture.input.sessionTitle)}</h2>
  <p>Requested style: ${escapeHtml(fixture.requestedStyle)} · Creation path: ${escapeHtml(fixture.creationPath)}</p>
  ${customDefinitionMarkup}
  <details><summary>Controlled context</summary><p>${escapeHtml(fixture.input.mood)} · ${escapeHtml(fixture.input.activity)} · ${escapeHtml(fixture.input.energy)} · ${escapeHtml(fixture.input.genreTags.join(', '))}</p></details>
  <fieldset>${ratingFields}<label class="notes"><span>Optional notes</span><textarea name="notes" maxlength="1000"></textarea></label></fieldset>
</article>`;
    })
    .join('\n');

  const clientSchema = JSON.stringify({
    schemaVersion: BASELINE_RATING_SCHEMA_VERSION,
    runId: args.manifest.run.id,
    reviewPass: args.reviewPass,
  }).replaceAll('<', '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Cover qualification · blind pass ${args.reviewPass}</title>
<style>
:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #111; color: #f5f5f5; }
body { margin: 0 auto; max-width: 1500px; padding: 24px; }
.instructions { max-width: 80ch; color: #d2d2d2; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 20px; }
.card { background: #1d1d1d; border: 1px solid #444; border-radius: 14px; padding: 14px; }
.card header { display: flex; justify-content: space-between; color: #bcbcbc; }
.card img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 9px; margin-top: 10px; }
.card h2 { font-size: 1.2rem; margin-bottom: 4px; }
fieldset { border: 0; margin: 0; padding: 0; }
label { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; margin: 12px 0; }
label small { color: #aaa; grid-column: 1; }
select { grid-column: 2; grid-row: 1 / span 2; min-width: 70px; }
.notes { grid-template-columns: 1fr; }
textarea { min-height: 60px; }
button { position: sticky; bottom: 14px; margin: 20px 0; padding: 12px 18px; font-weight: 700; }
.error { color: #ff9f9f; min-height: 1.5em; }
</style>
</head>
<body>
<h1>Session Cover qualification · blind pass ${args.reviewPass}</h1>
<div class="instructions">
<p>Rate the generated artwork, not the music request. Use the Session Name and requested style shown on each card. Higher is always better. Review related covers for distinctness before exporting.</p>
<p>This is one of two independently randomized passes. Complete it without consulting the manifest or the other pass.</p>
</div>
<main class="grid">${cards}</main>
<p id="error" class="error" role="alert"></p>
<button id="export" type="button">Export ratings JSON</button>
<script>
const review = ${clientSchema};
document.getElementById('export').addEventListener('click', () => {
  const cards = [...document.querySelectorAll('.card')];
  const ratings = [];
  for (const card of cards) {
    const values = {};
    for (const select of card.querySelectorAll('select')) {
      if (!select.value) {
        document.getElementById('error').textContent = 'Choose every rating before exporting.';
        select.focus();
        return;
      }
      values[select.name] = select.value === 'na' ? null : Number(select.value);
    }
    ratings.push({
      artifactId: card.dataset.blindArtifact,
      blindCode: card.dataset.blindCode,
      ratings: values,
      notes: card.querySelector('textarea').value.trim(),
    });
  }
  document.getElementById('error').textContent = '';
  const blob = new Blob([JSON.stringify({ ...review, completedAt: new Date().toISOString(), ratings }, null, 2) + '\\n'], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = review.runId + '-review-pass-' + review.reviewPass + '.json';
  link.click();
  URL.revokeObjectURL(link.href);
});
</script>
</body>
</html>
`;
}

export function getBaselineRatingSchema(): object {
  return {
    schemaVersion: BASELINE_RATING_SCHEMA_VERSION,
    scale: {
      minimum: 1,
      maximum: 5,
      direction: 'higher_is_better',
    },
    fields: RATING_FIELDS,
    referenceIntegrationMayBeNullWhenNotApplicable: true,
  };
}
