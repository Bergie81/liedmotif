// Manifest icon contract for Android WebAPK minting: PNG icons at 192/512 with
// `any` purpose plus a 512 `maskable` entry are what Chrome requires to install
// the app as a proper home-screen app (not a shortcut). The SVG entry serves
// capable browsers, and `display: standalone` keeps the installed app chromeless.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from './manifest';

describe('manifest', () => {
  const { icons, display, orientation } = manifest();

  it('declares a standalone display mode', () => {
    expect(display).toBe('standalone');
  });

  it('locks the installed app to portrait', () => {
    expect(orientation).toBe('portrait');
  });

  it('declares the scalable SVG icon entry', () => {
    expect(icons).toContainEqual(
      expect.objectContaining({ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }),
    );
  });

  it('declares 192 and 512 PNG icons with `any` purpose', () => {
    for (const size of ['192x192', '512x512']) {
      expect(icons).toContainEqual(
        expect.objectContaining({ sizes: size, type: 'image/png', purpose: 'any' }),
      );
    }
  });

  it('declares a 512 maskable PNG icon', () => {
    expect(icons).toContainEqual(
      expect.objectContaining({ sizes: '512x512', type: 'image/png', purpose: 'maskable' }),
    );
  });

  it('references only icon files that ship with the app', () => {
    for (const icon of icons ?? []) {
      const relative = icon.src.replace(/^\//, '');
      // Root-level icons (`/icon.svg`) are App Router file-convention assets in
      // `app/`; everything else is a plain static file under `public/`.
      const base = relative.includes('/') ? '../public/' : './';
      const path = fileURLToPath(new URL(base + relative, import.meta.url));
      expect(existsSync(path), `${icon.src} missing at ${path}`).toBe(true);
    }
  });
});
