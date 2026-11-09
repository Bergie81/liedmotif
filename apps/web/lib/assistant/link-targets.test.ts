import { describe, expect, it } from 'vitest';
import { resolveAnswerLink } from './answer-links';
import { answerLinkTargets } from './link-targets';

describe('answerLinkTargets', () => {
  const admin = answerLinkTargets('admin');
  const member = answerLinkTargets('member');

  it("holds the pages of the user's role", () => {
    expect(admin.appPaths).toContain('/settings/members');
    expect(admin.appPaths).toContain('/library');
    expect(member.appPaths).toContain('/library');
    expect(member.appPaths).not.toContain('/settings/members');
  });

  it('holds the docs pages of the snapshot, for either role', () => {
    expect(admin.docsPages).toContain('index');
    expect(admin.docsPages).toContain('backups');
    expect(admin.docsPages).toContain('install/local');
    expect(member.docsPages).toEqual(admin.docsPages);
  });

  it('lets an answer link to every page it lists', () => {
    for (const path of member.appPaths) {
      expect(resolveAnswerLink(path, member), path).toEqual({ kind: 'app', path });
    }
    for (const slug of member.docsPages) {
      expect(resolveAnswerLink(`/docs/${slug}`, member), slug).toMatchObject({ kind: 'docs' });
    }
  });

  it('lets a Member follow no link to an admin-only page', () => {
    for (const path of admin.appPaths.filter((path) => !member.appPaths.includes(path))) {
      expect(resolveAnswerLink(path, member), path).toBeNull();
    }
    expect(resolveAnswerLink('/settings/members', member)).toBeNull();
  });
});
