import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME, PERSONA_PROMPT } from './persona';
import { buildAssistantSystemPrompt } from './prompt';
import { APP_ROUTES } from './route-map';

const DOCS_INDEX = 'members: Members and invites\nBring people in.\n- intro\n- Invite someone';

const adminPrompt = buildAssistantSystemPrompt({ role: 'admin', docsIndex: DOCS_INDEX });
const memberPrompt = buildAssistantSystemPrompt({ role: 'member', docsIndex: DOCS_INDEX });

/** The prompt's line for a page: its path, then its name as the app shows it. */
const routeLine = (path: string, label: string) => `${path} — ${label}: `;

describe.each([
  ['the Admin', adminPrompt],
  ['a Member', memberPrompt],
])('the system prompt for %s', (_who, prompt) => {
  it('opens with the persona, then the rules, then the pages, and ends with the docs index', () => {
    expect(prompt.startsWith('You are Mo,')).toBe(true);
    expect(prompt.endsWith(DOCS_INDEX)).toBe(true);
    const rules = prompt.indexOf('Rules:');
    const pages = prompt.indexOf(routeLine('/library', 'Library'));
    expect(rules).toBeGreaterThan(prompt.indexOf(PERSONA_PROMPT));
    expect(pages).toBeGreaterThan(rules);
    expect(pages).toBeLessThan(prompt.indexOf(DOCS_INDEX));
  });

  it("tells the model to answer in the language of the user's latest message", () => {
    expect(prompt).toContain("Answer in the language of the user's latest message");
  });

  it('tells the model to keep screen and button names as the app shows them', () => {
    expect(prompt).toMatch(/names of screens, buttons and settings exactly as the app shows them/);
  });

  it('tells the model to read the docs through the tool and not to guess', () => {
    expect(prompt).toContain('readDocs');
    expect(prompt).toMatch(/never guess/i);
  });

  it('teaches one way to write an app link and one way to write a docs link', () => {
    // An app link: the page's name as the text, its bare path as the target.
    expect(prompt).toContain('[Settings › Playback](/settings/playback)');
    // A docs link: `/docs/` plus the page's slug, and `#` plus a heading's anchor.
    expect(prompt).toContain('(/docs/some-page)');
    expect(prompt).toContain('(/docs/some-page#some-section)');
    expect(prompt).toMatch(/never write any other link/i);
  });

  it('names the persona in the persona block only, so a rename touches one place', () => {
    expect(ASSISTANT_NAME).toBe('Mo');
    expect(PERSONA_PROMPT).toContain(ASSISTANT_NAME);
    expect(prompt.replace(PERSONA_PROMPT, '')).not.toMatch(/\bMo\b/);
  });
});

describe('buildAssistantSystemPrompt', () => {
  it('is the same text for every request of a role, so a provider can cache it', () => {
    expect(buildAssistantSystemPrompt({ role: 'admin', docsIndex: DOCS_INDEX })).toBe(adminPrompt);
    expect(buildAssistantSystemPrompt({ role: 'member', docsIndex: DOCS_INDEX })).toBe(
      memberPrompt,
    );
    expect(adminPrompt).not.toBe(memberPrompt);
  });

  it('shares everything before the pages between the roles, so that prefix caches once', () => {
    const shared = adminPrompt.slice(0, adminPrompt.indexOf(routeLine('/', 'Home')));
    expect(shared).toContain('Rules:');
    expect(memberPrompt.startsWith(shared)).toBe(true);
  });

  it("lists every page the Admin can open, with its name and what it's for", () => {
    expect(adminPrompt).toContain(
      `${routeLine('/settings/members', 'Settings › Members')}Invite people`,
    );
    expect(adminPrompt).toContain(routeLine('/settings/providers', 'Settings › AI Providers'));
    expect(adminPrompt).toContain(routeLine('/library', 'Library'));
    expect(adminPrompt).not.toMatch(/ask your Admin/i);
  });

  it('holds only non-admin pages for a Member', () => {
    for (const route of APP_ROUTES.filter(({ adminOnly }) => adminOnly)) {
      expect(memberPrompt, route.path).not.toContain(route.path);
      expect(memberPrompt, route.label).not.toContain(route.label);
    }
    expect(memberPrompt).toContain(routeLine('/library', 'Library'));
    expect(memberPrompt).toContain(routeLine('/settings/my-budget', 'Settings › My budget'));
  });

  it('tells a Member\'s model to say "ask your Admin" for what only the Admin can do', () => {
    expect(memberPrompt).toContain('ask your Admin');
  });
});
