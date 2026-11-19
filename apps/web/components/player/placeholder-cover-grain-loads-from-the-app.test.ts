// The Content Security Policy allows images only from the app itself
// (`img-src 'self' blob:`), so a `data:` texture in the placeholder's stylesheet
// is silently blocked and the film grain never shows. The grain has to be a
// file under `public/` that the app serves at the URL the stylesheet names.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  fileURLToPath(new URL('./placeholder-cover-motion.css', import.meta.url)),
  'utf8',
);

function grainRule(): string {
  const match = /\.pcm-grain\s*\{([^}]*)\}/.exec(stylesheet);
  if (!match) throw new Error('placeholder-cover-motion.css has no .pcm-grain rule');
  return match[1]!;
}

describe('placeholder cover film grain', () => {
  it('carries no data: image the security policy would block', () => {
    expect(stylesheet).not.toMatch(/url\(\s*['"]?data:/i);
  });

  it('loads its texture from a file the app serves', () => {
    const url = /background-image:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(grainRule())?.[1];
    expect(url, '.pcm-grain names no background-image url()').toBeDefined();
    expect(url).toMatch(/^\/[^/]/);
    const file = fileURLToPath(new URL(`../../public${url}`, import.meta.url));
    expect(existsSync(file), `public${url} does not exist`).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('feTurbulence');
  });
});
