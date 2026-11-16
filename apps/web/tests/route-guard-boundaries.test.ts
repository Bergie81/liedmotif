// Static boundary spec for the API surface (Invite Mode): every route
// under an instance-configuration path must gate on the admin-only guard
// (`requireAdminOwnerId`), and no route may skip a guard entirely. The
// exhaustive path list below IS the boundary decision — a new admin-only area
// gets added here with its route, so a route that reaches for the content guard
// by reflex fails this test instead of quietly granting a Member access to
// instance configuration.
//
// There is exactly ONE guard name per level, and all of them live in
// `lib/api-response`: a route that reaches past them into `lib/session` for the
// raw session getters fails here too, because a second spelling of the boundary
// is a second boundary to keep right. The same holds for body intake — the
// byte ceiling is only a ceiling if every route reads its JSON through the
// shared reader.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = join(__dirname, '..', 'app', 'api');

/** Instance configuration: admin-only, exhaustively. */
const ADMIN_ONLY_PREFIXES = [
  'settings/credentials',
  'settings/limits',
  'settings/voice',
  'settings/members',
  'settings/unit-costs',
  'settings/cost-comparison',
  'diagnostics',
  // Instance configuration despite the path: the credential probe answers
  // whether a provider's key works, and reaches the network to do it.
  'setup/validate',
];

/**
 * Unauthenticated by design (setup ladder, health, Better Auth, the one-shot
 * link submits, the forgot-password request — whoever asks is signed out by
 * definition — the CSP report sink — the browser posts violations with no
 * session, and the route only writes a log line — and the Instance alerts check,
 * token-gated and called by a host cron with no session).
 */
const UNAUTHENTICATED = [
  'auth/[...all]',
  'health',
  'setup',
  'join/claim',
  'join/reset',
  'join/confirm',
  'join/forgot',
  'csp-report',
  'alerts/check',
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function listRouteFiles(dir: string): string[] {
  return listSourceFiles(dir).filter((file) => file.endsWith(`${sep}route.ts`));
}

function routePath(file: string): string {
  return relative(API_ROOT, file).split(sep).slice(0, -1).join('/');
}

// `requireAdminAndMember` is the admin gate plus a member-id check, shared by the
// `/settings/members/[userId]` routes. It counts as the admin guard only
// because the spec below proves it opens with `requireAdminOwnerId` — one level
// of indirection is allowed, an unproven one is not.
const ADMIN_GUARDS = ['requireAdminOwnerId', 'requireAdminAndMember'];
const APP_GUARDS = ['requireOwnerId(', 'requireBytesOwnerId'];
/** The guards' own machinery — never a route's business. */
const RAW_SESSION_GETTERS = ['getAdminSession', 'getAppSession'];

describe('API route guard boundaries', () => {
  const files = listRouteFiles(API_ROOT);

  it('finds the API surface', () => {
    expect(files.length).toBeGreaterThan(70);
  });

  it('the shared member gate is itself an admin gate', () => {
    const source = readFileSync(join(API_ROOT, 'settings', 'members', 'member-route.ts'), 'utf8');
    expect(source).toContain('requireAdminOwnerId');
    expect(RAW_SESSION_GETTERS.filter((getter) => source.includes(getter))).toEqual([]);
  });

  it('no handler reads a JSON body outside the capped reader', () => {
    // `request.json()` buffers the whole body before anything can weigh it, so a
    // handler calling it directly is bounded only by the proxy's ceiling. Every
    // module under the API surface counts, not just the `route.ts` entrypoints:
    // handlers delegate to siblings (`settings/members/member-route.ts`).
    const offenders = listSourceFiles(API_ROOT).filter((file) =>
      /\b(request|req)\.json\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(API_ROOT, file))).toEqual([]);
  });

  for (const file of files) {
    const route = routePath(file);
    const source = readFileSync(file, 'utf8');
    const isAdminOnly = ADMIN_ONLY_PREFIXES.some(
      (prefix) => route === prefix || route.startsWith(`${prefix}/`),
    );
    const isUnauthenticated = UNAUTHENTICATED.includes(route);
    const usesAdminGuard = ADMIN_GUARDS.some((guard) => source.includes(guard));
    const usesAppGuard = APP_GUARDS.some((guard) => source.includes(guard));

    it(`${route} reaches the boundary only through lib/api-response`, () => {
      expect(RAW_SESSION_GETTERS.filter((getter) => source.includes(getter))).toEqual([]);
    });

    if (isUnauthenticated) continue;

    if (isAdminOnly) {
      it(`${route} gates on the admin-only guard`, () => {
        expect(usesAdminGuard).toBe(true);
        expect(usesAppGuard).toBe(false);
      });
    } else {
      it(`${route} gates on a guard`, () => {
        expect(usesAdminGuard || usesAppGuard).toBe(true);
      });
    }
  }
});
