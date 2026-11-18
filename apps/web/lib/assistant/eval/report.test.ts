import { describe, expect, it } from 'vitest';
import { mockLlmProvider, ProviderError, type LlmProvider } from '@liedmotif/providers';
import { EVAL_SET } from './eval-set';
import { PLAYLISTS, TRACKS } from './fixture';
import { renderEvalReport } from './report';
import { runEval, type EvalResult } from './run';

const pick = (...ids: string[]) => EVAL_SET.filter(({ id }) => ids.includes(id));

const INVITE_ANSWER =
  'Open **Settings › Members** and create an invite link.\n\nThen send it to her. ' +
  '[Settings › Members](/settings/members)';

/** A run in which the model reads the invite section and gives the same answer to everything. */
async function run(...ids: string[]): Promise<EvalResult[]> {
  const llm = mockLlmProvider({
    assistantScript: {
      toolCalls: [{ name: 'readDocs', input: { page: 'members', section: 'Invite someone' } }],
      reply: () => INVITE_ANSWER,
    },
  });
  return runEval(llm, pick(...ids));
}

/** A run in which the model makes `toolCalls` and gives `answer` to everything. */
async function act(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
  answer: string,
  ...ids: string[]
): Promise<EvalResult[]> {
  return runEval(mockLlmProvider({ assistantScript: { toolCalls, reply: () => answer } }), [
    ...pick(...ids),
  ]);
}

const report = (results: EvalResult[]) =>
  renderEvalReport({
    providerKey: 'ollama',
    model: 'qwen3:14b',
    startedAt: new Date('2026-11-09T10:00:00Z'),
    results,
  });

describe('the eval report', () => {
  it('names the model and the run once, at the top', async () => {
    const markdown = report(await run('invite-member'));

    expect(markdown).toContain('`qwen3:14b`');
    expect(markdown).toContain('`ollama`');
    expect(markdown).toContain('2026-11-09T10:00:00.000Z');
    expect(markdown.match(/qwen3:14b/g)).toHaveLength(1);
  });

  it('puts question, expected section, expected link and answer side by side for a human', async () => {
    const markdown = report(await run('invite-member'));

    expect(markdown).toContain('How do I invite my sister?');
    expect(markdown).toContain('members › invite-someone');
    expect(markdown).toContain('`/settings/members` (Settings › Members)');
    expect(markdown).toContain(
      '> Open **Settings › Members** and create an invite link.\n>\n> Then send it to her.',
    );
    expect(markdown).toContain('- [ ] The answer agrees with the docs');
    expect(markdown).toMatch(/not scored automatically/i);
  });

  it('counts each check over the questions it applies to', async () => {
    // The same English answer about invites: right for the Admin's invite
    // question, a made-up link where the docs have no answer, and the wrong
    // language for the German off-topic request, which expects no lookup.
    const markdown = report(await run('invite-member', 'not-in-the-docs', 'off-topic'));

    expect(markdown).toContain('| Called readDocs with a valid section | 2 / 2 |');
    expect(markdown).toContain('| Read the expected section | 1 / 1 |');
    expect(markdown).toContain('| Link correct | 2 / 3 |');
    expect(markdown).toContain('| Answered in the asked language | 2 / 3 |');
    expect(markdown).toContain('| Screen names left as shown | 1 / 1 |');
  });

  it('records tool calls, prompt size and time per question', async () => {
    const [result] = await run('invite-member');
    const markdown = report([{ ...result!, ms: 8240 }]);
    const { system, conversation, toolResults } = result!.promptChars;

    expect(markdown).toContain('- **Tool calls:** 1 (read members › invite-someone)');
    expect(markdown).toContain('8.2 s');
    expect(markdown).toContain(
      `${(system + conversation + toolResults).toLocaleString('en-US')} characters`,
    );
  });

  it('shows the earlier turns of a follow-up', async () => {
    const markdown = report(await run('follow-up-member-budget'));

    expect(markdown).toContain('Wie lade ich meine Schwester ein?');
    expect(markdown).toContain('Und wie ändere ich später, wie viel sie generieren darf?');
  });

  it('marks a failed question as failed, with the reason', async () => {
    const llm: LlmProvider = {
      ...mockLlmProvider(),
      // eslint-disable-next-line require-yield
      async *streamAssistantReply() {
        throw new ProviderError('The Text AI did not answer.');
      },
    };

    const markdown = report(await runEval(llm, pick('invite-member')));

    expect(markdown).toContain('Answered: 0 of 1');
    expect(markdown).toContain('**Failed:** The Text AI did not answer.');
    expect(markdown).toContain('| Link correct | 0 / 1 |');
  });

  it('lists the links the chat panel would not follow', async () => {
    const markdown = report(await run('member-asks-to-invite'));

    expect(markdown).toContain('shown as plain text: `/settings/members`');
  });

  it('shows each tool call next to the answer: what it was given and what it returned', async () => {
    const markdown = report(
      await act(
        [
          { name: 'findMusic', input: { kind: 'playlist', query: 'running' } },
          { name: 'play', input: { kind: 'playlist', id: PLAYLISTS.running.id } },
        ],
        'Running is playing.',
        'play-a-playlist',
      ),
    );

    expect(markdown).toContain('> Running is playing.');
    expect(markdown).toContain(
      '`findMusic` `{"kind":"playlist","query":"running"}` → Playlists matching "running":',
    );
    expect(markdown).toContain(
      `\`play\` \`{"kind":"playlist","id":"${PLAYLISTS.running.id}"}\` → Done: the player was told to play the Playlist "Running".`,
    );
  });

  it('says what the turn did for the user, in the words the app has for it', async () => {
    const favorited = report(
      await act([{ name: 'favoriteTrack', input: {} }], 'Added.', 'favorite-this'),
    );
    const proposed = report(
      await act(
        [{ name: 'proposeSession', input: { prompt: 'calm, for reading', noLimit: true } }],
        'A card is ready.',
        'start-a-session',
      ),
    );
    const nothing = report(await act([], 'I cannot do that.', 'remove-from-favorites'));

    expect(favorited).toContain(
      `- **Did:** receipt: added the Track "Neon Rain" (id ${TRACKS.neonRain.id}) to Favorites`,
    );
    expect(proposed).toContain(
      '- **Did:** card: start a new Session from "calm, for reading", instrumental',
    );
    expect(nothing).toContain('- **Did:** nothing');
  });

  it('puts the calls a good turn makes next to the ones the model made', async () => {
    const markdown = report(await act([], 'Done.', 'favorite-this', 'remove-from-favorites'));

    expect(markdown).toContain(
      `- **Expected calls:** \`favoriteTrack\` with \`{"trackId":"<left out>"}\` or \`{"trackId":"${TRACKS.neonRain.id}"}\``,
    );
    expect(markdown).toContain('- **Expected calls:** none that does anything');
    expect(markdown).toContain('- [ ] The answer says what happened, and nothing else');
    expect(markdown).not.toContain('- [ ] The answer agrees with the docs');
  });

  it('says which questions were asked with nothing playing', async () => {
    const [playing] = pick('favorite-this');
    const llm = mockLlmProvider({ assistantScript: { toolCalls: [], reply: () => 'Which one?' } });
    const results = await runEval(llm, [playing!, { ...playing!, nothingPlaying: true }]);

    const markdown = report(results);

    expect(markdown.match(/- \*\*Player:\*\* nothing playing/g)).toHaveLength(1);
  });

  it('counts the checks on what a turn did', async () => {
    // "Done." with no call made: right to do nothing for the removal, a false
    // claim in both, and the favorite never happened.
    const markdown = report(await act([], 'Done.', 'favorite-this', 'remove-from-favorites'));

    expect(markdown).toContain('| Called the expected tool | 0 / 1 |');
    expect(markdown).toContain('| Called it with the expected values | 0 / 1 |');
    expect(markdown).toContain('| Did nothing where nothing is expected | 1 / 1 |');
    expect(markdown).toContain('| Offered a card where one is expected | 0 / 0 |');
    expect(markdown).toContain('| Claimed nothing done without a receipt | 0 / 2 |');
  });

  it('reports the time to answer of requests apart from questions about the docs', async () => {
    const [docs, ...requests] = await act(
      [],
      'OK.',
      'invite-member',
      'next',
      'pause',
      'pin-a-playlist',
    );
    const timed = requests.map((result, index) => ({ ...result, ms: [900, 2400, 1500][index]! }));

    const markdown = report([{ ...docs!, ms: 8240 }, ...timed]);

    expect(markdown).toContain('| About the docs | 1 | 8.2 s | 8.2 s |');
    expect(markdown).toContain("| About the user's music | 3 | 1.5 s | 2.4 s |");
  });

  it('says once which Library and player the requests were asked against', async () => {
    const markdown = report(await run('invite-member', 'next'));

    expect(markdown.match(/"Night Drive"/g)).toHaveLength(1);
    expect(markdown).toMatch(/Nothing is read from the database or written to it/);
  });
});
