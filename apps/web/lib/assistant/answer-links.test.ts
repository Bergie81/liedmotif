import { describe, expect, it } from 'vitest';
import { DOCS_BASE_URL } from '@/lib/docs-links';
import { resolveAnswerLink, type AnswerLinkTargets } from './answer-links';

const ADMIN: AnswerLinkTargets = {
  appPaths: ['/', '/library', '/settings', '/settings/generation', '/settings/members'],
  docsPages: ['index', 'backups', 'members', 'install/local'],
};
const MEMBER: AnswerLinkTargets = {
  ...ADMIN,
  appPaths: ['/', '/library', '/settings', '/settings/generation'],
};

describe('resolveAnswerLink', () => {
  it("follows a path on the user's route map as an app link", () => {
    expect(resolveAnswerLink('/settings/members', ADMIN)).toEqual({
      kind: 'app',
      path: '/settings/members',
    });
    expect(resolveAnswerLink('/', MEMBER)).toEqual({ kind: 'app', path: '/' });
  });

  it('does not follow an admin path for a Member', () => {
    expect(resolveAnswerLink('/settings/members', MEMBER)).toBeNull();
  });

  it.each([
    ['a made-up path', '/settings/teleport'],
    ['a listed path with more behind it', '/settings/members/extra'],
    ['a listed path with letters appended', '/settings/membersx'],
    ['a listed path with a trailing slash', '/library/'],
    ['a listed path with a query string', '/library?tab=saved'],
    ['a listed path with an anchor', '/settings/generation#cost-controls'],
    ['a listed path on a full address', 'http://localhost:2206/library'],
    ['a listed path behind a space', ' /library'],
    ['a path without its leading slash', 'library'],
  ])('does not follow %s', (_what, href) => {
    expect(resolveAnswerLink(href, ADMIN)).toBeNull();
  });

  it.each([
    ['an outside address', 'https://example.com/'],
    ['an outside address that ends like an app page', 'https://example.com/library'],
    ['a protocol-relative address', '//example.com/library'],
    ['a script', 'javascript:alert(1)'],
    ['a mail address', 'mailto:someone@example.com'],
    ['an empty target', ''],
    ['a missing target', undefined],
  ])('does not follow %s', (_what, href) => {
    expect(resolveAnswerLink(href, ADMIN)).toBeNull();
  });

  it('follows a known docs page to the website', () => {
    expect(resolveAnswerLink('/docs/backups', MEMBER)).toEqual({
      kind: 'docs',
      url: 'https://liedmotif.com/docs/backups/',
    });
    expect(resolveAnswerLink('/docs/backups/', MEMBER)).toEqual({
      kind: 'docs',
      url: `${DOCS_BASE_URL}backups/`,
    });
    expect(resolveAnswerLink('/docs/install/local', MEMBER)).toEqual({
      kind: 'docs',
      url: `${DOCS_BASE_URL}install/local/`,
    });
  });

  it('keeps a heading anchor on a docs page', () => {
    expect(resolveAnswerLink('/docs/members#invite-someone', ADMIN)).toEqual({
      kind: 'docs',
      url: `${DOCS_BASE_URL}members/#invite-someone`,
    });
    expect(resolveAnswerLink('/docs/members/#invite-someone', ADMIN)).toEqual({
      kind: 'docs',
      url: `${DOCS_BASE_URL}members/#invite-someone`,
    });
  });

  it('follows the docs home', () => {
    for (const href of ['/docs', '/docs/', '/docs/index']) {
      expect(resolveAnswerLink(href, ADMIN), href).toEqual({ kind: 'docs', url: DOCS_BASE_URL });
    }
  });

  it("follows a docs page written as the website's own address", () => {
    expect(resolveAnswerLink(`${DOCS_BASE_URL}members/#invite-someone`, ADMIN)).toEqual({
      kind: 'docs',
      url: `${DOCS_BASE_URL}members/#invite-someone`,
    });
    expect(resolveAnswerLink(DOCS_BASE_URL, ADMIN)).toEqual({ kind: 'docs', url: DOCS_BASE_URL });
  });

  it.each([
    ['a docs page that does not exist', '/docs/teleporting'],
    ['a known docs page with more behind it', '/docs/backups/extra'],
    ['a known docs page with a query string', '/docs/backups?next=https://example.com'],
    ['an anchor that is not a heading anchor', '/docs/backups#"><img src=x>'],
    ['an anchor with a space', '/docs/backups#restore now'],
    ['an empty anchor', '/docs/backups#'],
    ['a path that climbs out of the docs', '/docs/../settings/members'],
    ['a path that only starts like the docs', '/docsbackups'],
    ['the docs on another host', 'https://liedmotif.com.example.net/docs/backups'],
    ['the docs over plain http', DOCS_BASE_URL.replace('https:', 'http:')],
  ])('does not follow %s', (_what, href) => {
    expect(resolveAnswerLink(href, ADMIN)).toBeNull();
  });

  it('follows no docs page when none is known', () => {
    expect(resolveAnswerLink('/docs/backups', { ...ADMIN, docsPages: [] })).toBeNull();
    expect(resolveAnswerLink('/docs', { ...ADMIN, docsPages: [] })).toBeNull();
  });
});
