import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocsPage } from './docs';
import { createAssistantTools, type AssistantAsker } from './tools';
import { TURN_READ_CHAR_BUDGET } from './turn-budget';

/** An asker whose database answers nothing: every lookup against it fails. */
const ASKER: AssistantAsker = { db: {} as never, userId: 'user-1', role: 'admin', player: null };

const page = (body: string) =>
  parseDocsPage('features', `---\ntitle: Features\ndescription: What it does.\n---\n\n${body}\n`);

const toolNamed = (tools: ReturnType<typeof createAssistantTools>, name: string) =>
  tools.find((tool) => tool.name === name)!;

/** Everything the server logged during a test, one string. */
let logged = '';

beforeEach(() => {
  logged = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    logged += String(line);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("one turn's tools", () => {
  it("are the docs tool and the tools that read the asking user's own data", () => {
    expect(createAssistantTools(ASKER, []).map((tool) => tool.name)).toEqual([
      'readDocs',
      'nowPlaying',
      'budget',
    ]);
  });

  it('tells the model a lookup failed, without the error and without logging the input', async () => {
    const tools = createAssistantTools(ASKER, []);

    const answer = await toolNamed(tools, 'nowPlaying').execute({ note: 'a private question' });

    expect(answer).toMatch(/could not be looked up/i);
    expect(answer).not.toMatch(/function|select|TypeError/);
    expect(logged).toContain('Assistant tool failed');
    expect(logged).toContain('"tool":"nowPlaying"');
    expect(logged).not.toContain('a private question');
  });

  it('draw on one budget: docs read first leave less for what is looked up after', async () => {
    const intro = 'x'.repeat(TURN_READ_CHAR_BUDGET);
    const tools = createAssistantTools(ASKER, [page(intro)]);

    expect(await toolNamed(tools, 'readDocs').execute({ page: 'features', section: 'intro' })).toBe(
      intro,
    );
    expect(await toolNamed(tools, 'nowPlaying').execute({})).toMatch(
      /more than you can still read.*answer from what you have/i,
    );
  });
});
