import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocsPage } from './docs';
import { createAssistantTools, type AssistantAsker } from './tools';
import { createTurnActions } from './turn-actions';
import { TURN_READ_CHAR_BUDGET } from './turn-budget';

/** An asker whose database answers nothing: every lookup against it fails. */
const ASKER: AssistantAsker = { db: {} as never, userId: 'user-1', role: 'admin', player: null };

const page = (body: string) =>
  parseDocsPage('features', `---\ntitle: Features\ndescription: What it does.\n---\n\n${body}\n`);

const toolNamed = (tools: ReturnType<typeof createAssistantTools>, name: string) =>
  tools.find((tool) => tool.name === name)!;

/** The tools of one turn over `pages`, and how many actions that turn reported. */
function openTurn(pages: Parameters<typeof createAssistantTools>[2] = []) {
  const reported: unknown[] = [];
  const tools = createAssistantTools(
    ASKER,
    createTurnActions((action) => reported.push(action)),
    pages,
  );
  return { tools, reported };
}

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
  it("are the docs tool, the tools that read the asking user's own data, the Library actions, the player commands and the ones that prepare a card", () => {
    expect(openTurn().tools.map((tool) => tool.name)).toEqual([
      'readDocs',
      'nowPlaying',
      'budget',
      'findMusic',
      'listTracks',
      'favoriteTrack',
      'addToPlaylist',
      'createPlaylist',
      'renamePlaylist',
      'pinPlaylist',
      'newMusicOff',
      'play',
      'playerControl',
      'sleepTimer',
      'proposeSession',
      'proposeChangeVibe',
      'proposeMoreLikeThis',
      'proposeNewMusicOn',
    ]);
  });

  it('hold nothing that removes: no unfavorite, no remove, no unsave, no delete', () => {
    for (const { name } of openTurn().tools) {
      expect(name).not.toMatch(/^un|unfavorite|unsave|unpin|remove|delete|dislike/i);
    }
  });

  it('tells the model a lookup failed, without the error and without logging the input', async () => {
    const { tools } = openTurn();

    const answer = await toolNamed(tools, 'nowPlaying').execute({ note: 'a private question' });

    expect(answer).toMatch(/could not be looked up/i);
    expect(answer).not.toMatch(/function|select|TypeError/);
    expect(logged).toContain('Assistant tool failed');
    expect(logged).toContain('"tool":"nowPlaying"');
    expect(logged).not.toContain('a private question');
  });

  it('draw on one budget: docs read first leave less for what is looked up after', async () => {
    const intro = 'x'.repeat(TURN_READ_CHAR_BUDGET);
    const { tools } = openTurn([page(intro)]);

    expect(await toolNamed(tools, 'readDocs').execute({ page: 'features', section: 'intro' })).toBe(
      intro,
    );
    expect(await toolNamed(tools, 'nowPlaying').execute({})).toMatch(
      /more than you can still read.*answer from what you have/i,
    );
  });

  it('tells the model an action failed, reports nothing, and logs no input', async () => {
    const { tools, reported } = openTurn();

    const answer = await toolNamed(tools, 'createPlaylist').execute({ name: 'A private name' });

    expect(answer).toMatch(/could not be done.*did not work/i);
    expect(reported).toEqual([]);
    expect(logged).toContain('"tool":"createPlaylist"');
    expect(logged).not.toContain('A private name');
  });

  it('always tell the model what an action came to, whatever was read before', async () => {
    const { tools } = openTurn([page('x'.repeat(TURN_READ_CHAR_BUDGET))]);
    await toolNamed(tools, 'readDocs').execute({ page: 'features', section: 'intro' });

    expect(await toolNamed(tools, 'createPlaylist').execute({ name: '' })).toMatch(
      /1 to 60 characters.*nothing was changed/i,
    );
  });
});
