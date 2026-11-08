import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overlayPathCandidates, stripPlaceholderRect } from './cover-branding';

describe('overlay asset resolution', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

  // A source run always resolves through this module's own location, so only
  // the cwd candidates prove that a bundled app — the Next standalone server or
  // the worker image rendering embedded album art — finds the SVG.
  it.each([
    ['the monorepo root', repoRoot],
    ['the web app', join(repoRoot, 'apps', 'web')],
    ['the worker app', join(repoRoot, 'apps', 'worker')],
  ])('finds the overlay from %s without this module’s own location', (_context, cwd) => {
    const [, ...cwdCandidates] = overlayPathCandidates(cwd);
    expect(cwdCandidates.some((candidate) => existsSync(candidate))).toBe(true);
  });

  // Webpack rewrites the module-relative `new URL(...)` into its own asset-URL
  // wrapper, which `fileURLToPath` rejects — the bundled web app must degrade
  // to the cwd candidates instead of throwing while building the list.
  it('degrades to the cwd candidates when the module-relative resolution throws', () => {
    const [, ...cwdCandidates] = overlayPathCandidates(repoRoot);
    expect(
      overlayPathCandidates(repoRoot, () => {
        throw new TypeError('cross-realm URL instance');
      }),
    ).toEqual(cwdCandidates);
  });
});

describe('stripPlaceholderRect', () => {
  it('removes a self-closing placeholder rect', () => {
    const svg = '<svg><rect id="cover" width="1024" height="1024"/><g id="logo"/></svg>';
    expect(stripPlaceholderRect(svg)).toBe('<svg><g id="logo"/></svg>');
  });

  it('removes a paired-form placeholder rect', () => {
    const svg = '<svg><rect id="cover" width="1024" height="1024"></rect><g id="logo"/></svg>';
    expect(stripPlaceholderRect(svg)).toBe('<svg><g id="logo"/></svg>');
  });

  it('leaves an asset without a placeholder rect unchanged', () => {
    const svg = '<svg><g id="logo"><rect id="bg1" width="247" height="99"/></g></svg>';
    expect(stripPlaceholderRect(svg)).toBe(svg);
  });
});
