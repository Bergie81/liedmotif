import { describe, expect, it } from 'vitest';
import { parseDocsPage } from './docs';
import { createReadDocsTool, SECTIONS_READ_CHAR_BUDGET } from './read-docs-tool';

const page = (slug: string, body: string) =>
  parseDocsPage(slug, `---\ntitle: ${slug}\ndescription: About ${slug}.\n---\n\n${body}\n`);

const PAGES = [
  page('members', 'Bring people in.\n\n## Invite someone\n\nCreate an invite link.'),
  page('backups', 'Keep a copy.\n\n## Restore a backup\n\nRun the restore script.'),
];

describe('the readDocs tool', () => {
  it('is the one tool the model reads the docs with', () => {
    const tool = createReadDocsTool(PAGES);

    expect(tool.name).toBe('readDocs');
    expect(tool.inputSchema.safeParse({ page: 'members', section: 'intro' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ page: 'members' }).success).toBe(false);
  });

  it('returns the Markdown of the section asked for', async () => {
    const tool = createReadDocsTool(PAGES);

    expect(await tool.execute({ page: 'members', section: 'Invite someone' })).toBe(
      '## Invite someone\n\nCreate an invite link.',
    );
  });

  it('answers a wrong section with the sections the page has', async () => {
    const answer = await createReadDocsTool(PAGES).execute({ page: 'members', section: 'Roles' });

    expect(answer).toContain('Roles');
    expect(answer).toContain('intro');
    expect(answer).toContain('Invite someone');
    expect(answer).not.toContain('Restore a backup');
  });

  it('answers a wrong page with the pages there are', async () => {
    const answer = await createReadDocsTool(PAGES).execute({ page: 'billing', section: 'intro' });

    expect(answer).toContain('billing');
    expect(answer).toContain('members');
    expect(answer).toContain('backups');
  });
});

describe("the readDocs tool within one turn's context budget", () => {
  // Two sections that each fit the budget, but not together.
  const big = (name: string) =>
    `## ${name}\n\n${'x'.repeat(Math.ceil(SECTIONS_READ_CHAR_BUDGET * 0.6))}`;
  const pages = [page('features', `Short intro.\n\n${big('Listen')}\n\n${big('Keep')}`)];

  it('stops handing out sections once the turn has read its share', async () => {
    const tool = createReadDocsTool(pages);

    expect(await tool.execute({ page: 'features', section: 'Listen' })).toContain('## Listen');
    const refused = await tool.execute({ page: 'features', section: 'Keep' });
    expect(refused).not.toContain('## Keep');
    expect(refused).toMatch(/answer from what you have read/i);
    // A section that still fits is still served.
    expect(await tool.execute({ page: 'features', section: 'intro' })).toBe('Short intro.');
  });

  it('starts every turn with a full budget', async () => {
    await createReadDocsTool(pages).execute({ page: 'features', section: 'Listen' });

    expect(
      await createReadDocsTool(pages).execute({ page: 'features', section: 'Keep' }),
    ).toContain('## Keep');
  });
});
