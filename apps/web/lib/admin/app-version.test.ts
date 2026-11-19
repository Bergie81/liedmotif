import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './app-version';

describe('APP_VERSION', () => {
  // Diagnostics shows this to a self-hoster asking "is this instance current?",
  // so it has to be the shipped release — the root manifest both runtimes are
  // built from — and never a bundler artifact like `undefined`.
  it('is the version of the root workspace manifest', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };

    expect(APP_VERSION).toBe(manifest.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
