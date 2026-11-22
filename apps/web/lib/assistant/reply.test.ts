import { mockLlmProvider, type AssistantReplyInput, type LlmTool } from '@liedmotif/providers';
import type { AssistantMessage } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { streamAssistantAnswer } from './reply';

const QUOTING = 'Play the song that goes “zu viert auf dem mnod”';
const FOUND = 'Tracks: - "Vier im Mondorbit" · Session "Mondflug ohne Rückfahrkarte"';

const findTool: LlmTool<{ query: string }> = {
  name: 'find',
  description: 'Finds music.',
  inputSchema: z.object({ query: z.string() }),
  execute: async () => FOUND,
};

/**
 * One turn with a text LLM that reads `language` from the message, calls
 * `find` once and writes `answer`: what the model was asked about the
 * language, what the reply's model calls were sent, what the tool handed
 * them, and what the user is shown.
 */
async function turn(
  messages: readonly AssistantMessage[],
  { language, answer = 'It plays.' }: { language: string; answer?: string },
) {
  const languageAsked: string[] = [];
  const sent: AssistantReplyInput[] = [];
  const toolResults: string[] = [];
  const mock = mockLlmProvider({
    assistantScript: {
      toolCalls: [{ name: 'find', input: { query: 'mond' } }],
      reply: (results) => {
        toolResults.push(...results);
        return answer;
      },
    },
  });
  const llm = {
    ...mock,
    async readMessageLanguage({ text }: { text: string }) {
      languageAsked.push(text);
      return language;
    },
    streamAssistantReply(input: AssistantReplyInput) {
      sent.push(input);
      return mock.streamAssistantReply(input);
    },
  };
  let shown = '';
  for await (const chunk of streamAssistantAnswer(
    llm,
    { role: 'admin' },
    [findTool],
    messages,
    new AbortController().signal,
  )) {
    shown += chunk;
  }
  return { languageAsked, sent: sent[0]!, toolResults, shown };
}

const ENGLISH_LINE =
  '[Answer language, set by the app: English. Write the answer in English, whatever language the names, titles and lyrics around it are in.]';

describe("an Assistant turn answers in the language of the user's own words", () => {
  it('has the language read from the latest message alone', async () => {
    const { languageAsked } = await turn(
      [
        { role: 'user', content: 'Was läuft gerade?' },
        { role: 'assistant', content: '„Vier im Mondorbit“ läuft. Passt schon.' },
        { role: 'user', content: QUOTING },
      ],
      { language: 'English' },
    );

    expect(languageAsked).toEqual([QUOTING]);
  });

  it('names that language right after the latest message, and leaves earlier messages as they were', async () => {
    const earlier: AssistantMessage[] = [
      { role: 'user', content: 'Was läuft gerade?' },
      { role: 'assistant', content: '„Vier im Mondorbit“ läuft. Passt schon.' },
    ];
    const { sent } = await turn([...earlier, { role: 'user', content: QUOTING }], {
      language: 'English',
    });

    expect(sent.messages).toEqual([
      ...earlier,
      { role: 'user', content: `${QUOTING}\n\n${ENGLISH_LINE}` },
    ]);
  });

  it('names it again after what every tool returns, so it is the last thing read before the answer', async () => {
    const { toolResults } = await turn([{ role: 'user', content: QUOTING }], {
      language: 'English',
    });

    expect(toolResults).toEqual([`${FOUND}\n\n${ENGLISH_LINE}`]);
  });

  it('tells the model in its instructions what that line is', async () => {
    const { sent } = await turn([{ role: 'user', content: QUOTING }], { language: 'English' });

    expect(sent.system).toContain('[Answer language, set by the app:');
  });

  it('adds nothing when the message tells no language: the conversation decides', async () => {
    const messages: AssistantMessage[] = [{ role: 'user', content: 'ok' }];
    const { sent, toolResults } = await turn(messages, { language: '' });

    expect(sent.messages).toEqual(messages);
    expect(toolResults).toEqual([FOUND]);
  });

  it('never shows the user that line, should the model copy it into its answer', async () => {
    const { shown } = await turn([{ role: 'user', content: QUOTING }], {
      language: 'English',
      answer: `“Vier im Mondorbit” is on.\n\n${ENGLISH_LINE}`,
    });

    expect(shown.trim()).toBe('“Vier im Mondorbit” is on.');
  });
});
