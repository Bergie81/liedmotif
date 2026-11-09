import { describe, expect, it } from 'vitest';
import { mockLlmProvider, ProviderError, type LlmProvider } from '@liedmotif/providers';
import { EVAL_SET } from './eval-set';
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
    const { system, conversation, docsRead } = result!.promptChars;

    expect(markdown).toContain('1 tool call');
    expect(markdown).toContain('8.2 s');
    expect(markdown).toContain(
      `${(system + conversation + docsRead).toLocaleString('en-US')} characters`,
    );
    expect(markdown).toContain('read members › invite-someone');
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
        throw new ProviderError('The Writing AI did not answer.');
      },
    };

    const markdown = report(await runEval(llm, pick('invite-member')));

    expect(markdown).toContain('Answered: 0 of 1');
    expect(markdown).toContain('**Failed:** The Writing AI did not answer.');
    expect(markdown).toContain('| Link correct | 0 / 1 |');
  });

  it('lists the links the chat panel would not follow', async () => {
    const markdown = report(await run('member-asks-to-invite'));

    expect(markdown).toContain('shown as plain text: `/settings/members`');
  });
});
