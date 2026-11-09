// The eval run against stand-ins for the text LLM: the mock provider, and the
// real adapter over a scripted model. No test here reaches a network.

import { describe, expect, it } from 'vitest';
import {
  createOpenRouterLlmProvider,
  mockLlmProvider,
  ProviderError,
  type LlmProvider,
} from '@liedmotif/providers';
import { scriptedLanguageModel } from '@liedmotif/providers/testing';
import { buildDocsIndex, loadDocs, readDocsSection } from '../docs';
import { buildAssistantSystemPrompt } from '../prompt';
import { EVAL_SET, type EvalEntry } from './eval-set';
import { runEval } from './run';

const entry = (id: string): EvalEntry => {
  const found = EVAL_SET.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no eval entry "${id}"`);
  return found;
};

const INVITE = entry('invite-member');
const FOLLOW_UP = entry('follow-up-member-budget');

const INVITE_ANSWER =
  'Open **Settings › Members** and create an invite link, then send it to her. ' +
  'Her music is paid from your keys. [Settings › Members](/settings/members)';

const readsInviteSection = {
  name: 'readDocs',
  input: { page: 'members', section: 'Invite someone' },
};

const sectionText = (page: string, section: string): string => {
  const lookup = readDocsSection(loadDocs(), page, section);
  if (!lookup.found) throw new Error(`no section ${page} › ${section}`);
  return lookup.markdown;
};

function scriptedProvider(steps: Parameters<typeof scriptedLanguageModel>[0]) {
  const model = scriptedLanguageModel(steps);
  const llm = createOpenRouterLlmProvider({
    apiKey: 'sk-or-test-key',
    model: 'test-model',
    languageModel: model,
  });
  return { model, llm };
}

describe('an eval run', () => {
  it('scores a turn that reads the expected section and answers with the expected link', async () => {
    const llm = mockLlmProvider({
      assistantScript: { toolCalls: [readsInviteSection], reply: () => INVITE_ANSWER },
    });

    const [result] = await runEval(llm, [INVITE]);

    expect(result?.turn.answer).toBe(INVITE_ANSWER);
    expect(result?.score).toMatchObject({
      validRead: 'pass',
      expectedRead: 'pass',
      link: 'pass',
      language: 'pass',
      screenNames: 'pass',
    });
  });

  it('scores a turn that answers without the docs and without a link', async () => {
    const llm = mockLlmProvider({
      assistantScript: { reply: () => 'You can invite her from the settings of the app.' },
    });

    const [result] = await runEval(llm, [INVITE]);

    expect(result?.score).toMatchObject({
      validRead: 'fail',
      expectedRead: 'fail',
      link: 'fail',
      language: 'pass',
      screenNames: 'fail',
    });
  });

  it('records the tool calls, the size of what the model was sent and the time', async () => {
    const llm = mockLlmProvider({
      assistantScript: { toolCalls: [readsInviteSection], reply: () => INVITE_ANSWER },
    });

    const [result] = await runEval(llm, [INVITE]);

    expect(result?.turn.toolCalls).toEqual([
      { ...readsInviteSection, result: sectionText('members', 'invite-someone') },
    ]);
    expect(result?.promptChars).toEqual({
      // The Admin's real system prompt, over the real docs snapshot.
      system: buildAssistantSystemPrompt({ role: 'admin', docsIndex: buildDocsIndex(loadDocs()) })
        .length,
      conversation: INVITE.question.length,
      docsRead: sectionText('members', 'invite-someone').length,
    });
    expect(result?.ms).toBeGreaterThanOrEqual(0);
  });

  it("sends the role's system prompt and the earlier turns to the model", async () => {
    const { model, llm } = scriptedProvider([
      { toolCalls: [{ name: 'readDocs', input: { page: 'members', section: 'intro' } }] },
      { text: ['Drücke **Edit budget** ', 'auf ihrer Karte.'] },
    ]);

    const [result] = await runEval(llm, [FOLLOW_UP]);

    expect(result?.turn.answer).toBe('Drücke **Edit budget** auf ihrer Karte.');
    expect(result?.turn.toolCalls.map(({ input }) => input)).toEqual([
      { page: 'members', section: 'intro' },
    ]);
    const sent = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(sent).toContain('This user is the Admin of this Liedmotif.');
    expect(sent).toContain(FOLLOW_UP.history![0]!.content);
    expect(sent).toContain(FOLLOW_UP.question);
  });

  it('asks each question once, in order, and goes on after one fails', async () => {
    const asked: string[] = [];
    const llm = mockLlmProvider();
    const failsOnInvite: LlmProvider = {
      ...llm,
      async *streamAssistantReply(input) {
        const question = input.messages.at(-1)!.content;
        asked.push(question);
        if (question === INVITE.question) throw new ProviderError('The Writing AI did not answer.');
        yield 'Nimm **Edit budget**.';
      },
    };
    const reported: string[] = [];

    const results = await runEval(failsOnInvite, [INVITE, FOLLOW_UP], {
      onResult: (result) => reported.push(result.entry.id),
    });

    expect(asked).toEqual([INVITE.question, FOLLOW_UP.question]);
    expect(reported).toEqual([INVITE.id, FOLLOW_UP.id]);
    expect(results[0]?.turn.error).toBe('The Writing AI did not answer.');
    expect(results[0]?.score).toMatchObject({ validRead: 'fail', link: 'fail', language: 'fail' });
    expect(results[1]?.turn).toMatchObject({ answer: 'Nimm **Edit budget**.' });
    expect(results[1]?.turn.error).toBeUndefined();
  });

  it('never repeats what an unexpected failure said', async () => {
    const llm: LlmProvider = {
      ...mockLlmProvider(),
      // eslint-disable-next-line require-yield
      async *streamAssistantReply() {
        throw new Error('401 from https://llm.example.test with key sk-secret');
      },
    };

    const [result] = await runEval(llm, [INVITE]);

    expect(result?.turn.error).toBeDefined();
    expect(result?.turn.error).not.toContain('sk-secret');
    expect(result?.turn.error).not.toContain('llm.example.test');
  });

  it('gives up on a question the model does not answer in time', async () => {
    const { model, llm } = scriptedProvider([{ hang: true }]);

    const results = await runEval(llm, [INVITE], { timeoutMs: 30 });

    expect(results[0]?.turn.error).toMatch(/no answer within/i);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});
