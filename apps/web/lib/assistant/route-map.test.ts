import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_ROUTES, appRoutesFor } from './route-map';

const appDir = fileURLToPath(new URL('../../app/', import.meta.url));

/** URL path → the `page.tsx` that serves it. Route groups (`(app)`) are not part of the URL. */
function readAppPages(): Map<string, string> {
  const pages = new Map<string, string>();
  for (const file of readdirSync(appDir, { recursive: true, encoding: 'utf8' })) {
    const segments = file.replace(/\\/g, '/').split('/');
    if (segments.pop() !== 'page.tsx') continue;
    const path = `/${segments.filter((segment) => !/^\(.*\)$/.test(segment)).join('/')}`;
    pages.set(path, join(appDir, file));
  }
  return pages;
}

describe('the route map', () => {
  const pages = readAppPages();

  it('finds the app pages it is checked against', () => {
    expect(pages.has('/')).toBe(true);
    expect(pages.has('/settings/members')).toBe(true);
    expect(pages.has('/settings/no-such-page')).toBe(false);
  });

  it.each(APP_ROUTES.map((route) => [route.path, route] as const))(
    '%s is a real app page',
    (path) => {
      expect(pages.has(path), `no page.tsx serves ${path}`).toBe(true);
    },
  );

  it('marks every page behind the admin guard as admin-only', () => {
    for (const route of APP_ROUTES) {
      const source = readFileSync(pages.get(route.path)!, 'utf8');
      if (source.includes('requireAdmin()')) {
        expect(route.adminOnly, `${route.path} is guarded by requireAdmin()`).toBe(true);
      }
    }
  });

  it('names each page once, with a label and what you do there', () => {
    expect(new Set(APP_ROUTES.map(({ path }) => path)).size).toBe(APP_ROUTES.length);
    expect(new Set(APP_ROUTES.map(({ label }) => label)).size).toBe(APP_ROUTES.length);
    for (const route of APP_ROUTES) {
      expect(route.label.trim(), route.path).not.toBe('');
      expect(route.description.trim(), route.path).not.toBe('');
    }
  });
});

describe('appRoutesFor', () => {
  const paths = (role: 'admin' | 'member') => appRoutesFor(role).map(({ path }) => path);

  it('gives a Member no admin-only page', () => {
    expect(appRoutesFor('member').some((route) => route.adminOnly)).toBe(false);
    expect(paths('member')).not.toContain('/settings/members');
    expect(paths('member')).not.toContain('/settings/providers');
    expect(paths('member')).toContain('/library');
    expect(paths('member')).toContain('/settings/playback');
  });

  it('gives the Admin the admin-only pages too', () => {
    expect(paths('admin')).toContain('/settings/members');
    expect(paths('admin')).toContain('/settings/providers');
    expect(paths('admin')).toContain('/library');
  });

  it('keeps the page only a Member has away from the Admin', () => {
    expect(paths('member')).toContain('/settings/my-budget');
    expect(paths('admin')).not.toContain('/settings/my-budget');
  });
});
