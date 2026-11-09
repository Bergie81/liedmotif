import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME, PERSONA_PROMPT } from './persona';
import { buildAssistantSystemPrompt } from './prompt';

const DOCS_INDEX = 'members: Members and invites\nBring people in.\n- intro\n- Invite someone';

describe('buildAssistantSystemPrompt', () => {
  const prompt = buildAssistantSystemPrompt({ docsIndex: DOCS_INDEX });

  it('opens with the persona, then the rules, and ends with the docs index', () => {
    expect(prompt.startsWith('You are Mo,')).toBe(true);
    expect(prompt.endsWith(DOCS_INDEX)).toBe(true);
    const rules = prompt.indexOf('Rules:');
    expect(rules).toBeGreaterThan(prompt.indexOf(PERSONA_PROMPT));
    expect(rules).toBeLessThan(prompt.indexOf(DOCS_INDEX));
  });

  it('is the same text every time, so a provider can cache it', () => {
    expect(buildAssistantSystemPrompt({ docsIndex: DOCS_INDEX })).toBe(prompt);
  });

  it("tells the model to answer in the language of the user's latest message", () => {
    expect(prompt).toContain("Answer in the language of the user's latest message");
  });

  it('tells the model to keep screen and button names as the app shows them', () => {
    expect(prompt).toMatch(/names of screens, buttons and settings exactly as the app shows them/);
    expect(prompt).toContain('**Settings › Members**');
  });

  it('tells the model to read the docs through the tool and not to guess', () => {
    expect(prompt).toContain('readDocs');
    expect(prompt).toMatch(/never guess/i);
  });

  it('names the persona in the persona block only, so a rename touches one place', () => {
    expect(ASSISTANT_NAME).toBe('Mo');
    expect(PERSONA_PROMPT).toContain(ASSISTANT_NAME);
    expect(prompt.replace(PERSONA_PROMPT, '')).not.toMatch(/\bMo\b/);
  });
});
