import { describe, expect, it } from 'vitest';
import { buildDocsIndex, parseDocsPage, readDocsSection } from './docs';

const MEMBERS = `---
title: Members and invites
description: Bring people onto your Liedmotif, and set what they can spend.
checkedOn: 2026-11-07
---

Each person you invite becomes a member.

## Invite someone

1. Open **Settings › Members**.

### With account email

Liedmotif mails the link.

## Budgets: what a member can spend

\`\`\`bash
## not a heading
docker compose up -d
\`\`\`
`;

describe('parseDocsPage', () => {
  it('reads the title and description from the frontmatter', () => {
    const page = parseDocsPage('members', MEMBERS);

    expect(page.slug).toBe('members');
    expect(page.title).toBe('Members and invites');
    expect(page.description).toBe('Bring people onto your Liedmotif, and set what they can spend.');
  });

  it('splits the page at its ## headings, with the text before the first one as intro', () => {
    const page = parseDocsPage('members', MEMBERS);

    expect(page.sections).toEqual([
      { id: 'intro', heading: 'intro', markdown: 'Each person you invite becomes a member.' },
      {
        id: 'invite-someone',
        heading: 'Invite someone',
        markdown: [
          '## Invite someone',
          '',
          '1. Open **Settings › Members**.',
          '',
          '### With account email',
          '',
          'Liedmotif mails the link.',
        ].join('\n'),
      },
      {
        id: 'budgets-what-a-member-can-spend',
        heading: 'Budgets: what a member can spend',
        markdown: [
          '## Budgets: what a member can spend',
          '',
          '```bash',
          '## not a heading',
          'docker compose up -d',
          '```',
        ].join('\n'),
      },
    ]);
  });

  it('has no intro section when the page opens with a heading', () => {
    const page = parseDocsPage(
      'faq',
      '---\ntitle: FAQ\ndescription: Answers.\n---\n\n## Costs\n\nNone.\n',
    );

    expect(page.sections.map((section) => section.id)).toEqual(['costs']);
  });
});

const PAGES = [
  parseDocsPage('members', MEMBERS),
  parseDocsPage(
    'install/local',
    '---\ntitle: Install on your laptop\ndescription: Run it with Docker.\n---\n\n## 1. Install Docker\n\nGet Docker Desktop.\n',
  ),
];

describe('buildDocsIndex', () => {
  it('lists every page with its slug, title, description and section headings', () => {
    expect(buildDocsIndex(PAGES)).toBe(
      [
        'members: Members and invites',
        'Bring people onto your Liedmotif, and set what they can spend.',
        '- intro',
        '- Invite someone',
        '- Budgets: what a member can spend',
        '',
        'install/local: Install on your laptop',
        'Run it with Docker.',
        '- 1. Install Docker',
      ].join('\n'),
    );
  });
});

describe('readDocsSection', () => {
  it('returns the Markdown of a section named by its id', () => {
    expect(readDocsSection(PAGES, 'install/local', '1-install-docker')).toEqual({
      found: true,
      page: 'install/local',
      section: '1-install-docker',
      markdown: '## 1. Install Docker\n\nGet Docker Desktop.',
    });
  });

  it('finds a section named by its heading as the index shows it', () => {
    const result = readDocsSection(PAGES, 'members', 'Budgets: what a member can spend');

    expect(result).toMatchObject({ found: true, section: 'budgets-what-a-member-can-spend' });
  });

  it('returns the intro section', () => {
    expect(readDocsSection(PAGES, 'members', 'intro')).toMatchObject({
      found: true,
      markdown: 'Each person you invite becomes a member.',
    });
  });

  it('finds a page named the way the docs link to it', () => {
    expect(readDocsSection(PAGES, '/docs/install/local/', '1-install-docker')).toMatchObject({
      found: true,
      page: 'install/local',
    });
  });

  it('lists the pages when the page is unknown', () => {
    expect(readDocsSection(PAGES, 'invites', 'intro')).toEqual({
      found: false,
      reason: 'unknown-page',
      pages: ['members', 'install/local'],
    });
  });

  it("lists the page's sections when the section is unknown", () => {
    expect(readDocsSection(PAGES, 'members', 'Remove someone')).toEqual({
      found: false,
      reason: 'unknown-section',
      page: 'members',
      sections: ['intro', 'Invite someone', 'Budgets: what a member can spend'],
    });
  });
});
