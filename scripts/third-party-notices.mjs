// Writes THIRD_PARTY_NOTICES.txt for the published images. Next's standalone trace
// and the worker bundle both drop the license files their packages ship with, so
// the text has to be collected from the full install before those steps' output
// is copied into an image. It covers every production package installed on the
// building arch, a superset of what any one image contains.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LICENSE_FILE_NAME = /^(licen[cs]e|copying|notice|thirdpartynotice\w*)([-._].*)?$/i;
const SOURCE_FILE_NAME = /\.(c?js|mjs|ts|json|map|html)$/i;
const SEPARATOR = '='.repeat(78);

function licenseFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && LICENSE_FILE_NAME.test(entry.name) && !SOURCE_FILE_NAME.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

function licenseTexts(dir) {
  return licenseFiles(dir).map((name) => readFileSync(join(dir, name), 'utf8').trim());
}

function projectUrl(name, manifest) {
  const repository = manifest.repository;
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) return `https://www.npmjs.com/package/${name}`;
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

function subdirectories(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Next ships its own dependencies precompiled under dist/compiled, each with its
// license beside it.
function vendoredPackages(packageDir) {
  const compiled = join(packageDir, 'dist', 'compiled');
  if (!existsSync(compiled)) return [];
  return subdirectories(compiled).flatMap((name) => {
    if (!name.startsWith('@')) return [name];
    return subdirectories(join(compiled, name)).map((scoped) => `${name}/${scoped}`);
  });
}

function section(title, lines) {
  return [SEPARATOR, title, SEPARATOR, '', ...lines, ''].join('\n');
}

function packageSections(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const sections = new Map();

  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || entry.dev || entry.link) continue;
    const dir = join(root, path);
    if (!existsSync(dir)) continue;

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const texts = licenseTexts(dir);
    const body = texts.length
      ? texts
      : [`No license file in the package. See ${projectUrl(name, manifest)}`];
    const license = entry.license ?? manifest.license ?? 'not stated';
    sections.set(
      `${name}@${manifest.version}`,
      section(`${name}@${manifest.version}`, [`License: ${license}`, '', ...body]),
    );

    for (const vendored of vendoredPackages(dir)) {
      const vendoredDir = join(dir, 'dist', 'compiled', vendored);
      const vendoredTexts = licenseTexts(vendoredDir);
      if (!vendoredTexts.length) continue;
      const title = `${name}/dist/compiled/${vendored}`;
      sections.set(title, section(title, vendoredTexts));
    }
  }
  return sections;
}

function nonNpmSections(root) {
  const dir = join(root, 'docker', 'third-party-licenses');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => section(name, [readFileSync(join(dir, name), 'utf8').trim()]));
}

export function thirdPartyNotices(root) {
  const packages = packageSections(root);
  if (packages.size === 0) {
    throw new Error('No installed production packages found: is node_modules there?');
  }
  const ordered = [...packages.keys()].sort().map((key) => packages.get(key));
  return [
    'Third-party software in this Liedmotif image, with its license terms.',
    "Liedmotif's own license is in LICENSE.md. NOTICE.md covers FFmpeg, libvips,",
    'rsync and where to find their source.',
    '',
    ...ordered,
    ...nonNpmSections(root),
  ].join('\n');
}

if (import.meta.main) {
  writeFileSync(process.argv[2], thirdPartyNotices(process.cwd()));
}
