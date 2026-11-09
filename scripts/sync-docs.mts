// Refreshes the app's docs snapshot from the website repo checked out next to
// this one (`npm run docs:sync`). The Assistant answers from the snapshot, so it
// is committed: the app never reads the website repo, and its answers match the
// installed version.

import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteDocsDir = join(repoRoot, '..', '..', 'liedmotif-landingpage', 'src', 'content', 'docs');
const snapshotDir = join(repoRoot, 'apps', 'web', 'docs-snapshot');

if (!existsSync(siteDocsDir)) {
  console.error(`No website docs at ${siteDocsDir}: check out the website repo there first.`);
  process.exit(1);
}

// Removed first, so a page deleted on the website leaves the snapshot too.
rmSync(snapshotDir, { recursive: true, force: true });
cpSync(siteDocsDir, snapshotDir, {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || source.endsWith('.md'),
});

const pages = readdirSync(snapshotDir, { recursive: true, encoding: 'utf8' }).filter((file) =>
  file.endsWith('.md'),
);
console.log(`Copied ${pages.length} docs pages to apps/web/docs-snapshot`);
