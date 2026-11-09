// The eval set's expectations name docs sections and app pages. Both move: the
// docs snapshot is re-synced from the website, and the route map grows. An
// entry that points at something that is gone would score every model wrong, so
// each one is checked against the real snapshot and the real route map.

import { describe, expect, it } from 'vitest';
import { assistantRequestSchema } from '@liedmotif/shared';
import { loadDocs, readDocsSection } from '../docs';
import { APP_ROUTES, appRoutesFor } from '../route-map';
import { EVAL_SET, type DocsRef, type EvalEntry } from './eval-set';
import { detectLanguage } from './score';

const sections = (entry: EvalEntry): readonly DocsRef[] =>
  Array.isArray(entry.docs) ? entry.docs : [];

const count = (matches: (entry: EvalEntry) => boolean) => EVAL_SET.filter(matches).length;

describe('the eval set', () => {
  it('is about 20 questions, each with its own id', () => {
    expect(EVAL_SET.length).toBeGreaterThanOrEqual(18);
    expect(EVAL_SET.length).toBeLessThanOrEqual(24);
    expect(new Set(EVAL_SET.map(({ id }) => id)).size).toBe(EVAL_SET.length);
  });

  it.each(EVAL_SET.flatMap((entry) => sections(entry).map((ref) => [entry.id, ref] as const)))(
    '%s expects a section the docs snapshot has: %o',
    (_id, ref) => {
      expect(readDocsSection(loadDocs(), ref.page, ref.section)).toMatchObject({ found: true });
    },
  );

  it.each(
    EVAL_SET.filter(({ link }) => link !== null).map(({ id, role, link }) => [id, role, link]),
  )('%s expects a page the route map lists for the %s: %s', (_id, role, link) => {
    expect(appRoutesFor(role as EvalEntry['role']).map(({ path }) => path)).toContain(link);
  });

  it.each(EVAL_SET.map((entry) => [entry.id, entry] as const))(
    '%s is a conversation the chat panel could send',
    (_id, { history = [], question }) => {
      const messages = [...history, { role: 'user', content: question }];

      expect(assistantRequestSchema.safeParse({ messages }).success).toBe(true);
    },
  );

  it.each(EVAL_SET.map((entry) => [entry.id, entry] as const))(
    '%s is asked in the language it expects the answer in',
    (_id, { question, language }) => {
      expect(detectLanguage(question)).toBe(language);
    },
  );

  it('asks as the Admin and as a Member', () => {
    expect(count(({ role }) => role === 'admin')).toBeGreaterThanOrEqual(5);
    expect(count(({ role }) => role === 'member')).toBeGreaterThanOrEqual(5);
  });

  it('asks at least 5 questions in German and 2 in French', () => {
    expect(count(({ language }) => language === 'de')).toBeGreaterThanOrEqual(5);
    expect(count(({ language }) => language === 'fr')).toBeGreaterThanOrEqual(2);
  });

  it('has a Member ask about something only the Admin has a page for', () => {
    const adminPages = APP_ROUTES.filter(({ adminOnly }) => adminOnly).map(({ label }) => label);
    const sendsToAnAdminPage = (ref: DocsRef) => {
      const lookup = readDocsSection(loadDocs(), ref.page, ref.section);
      return lookup.found && adminPages.some((label) => lookup.markdown.includes(label));
    };

    expect(
      count(
        (entry) =>
          entry.role === 'member' &&
          entry.link === null &&
          sections(entry).some(sendsToAnAdminPage),
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('has a question the docs do not answer, an off-topic request and a follow-up', () => {
    expect(count(({ docs }) => docs === 'lookup')).toBeGreaterThanOrEqual(1);
    expect(count(({ docs }) => docs === 'none')).toBeGreaterThanOrEqual(1);
    expect(count(({ history }) => (history?.length ?? 0) > 0)).toBeGreaterThanOrEqual(1);
  });
});
