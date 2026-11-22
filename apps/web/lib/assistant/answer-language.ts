// The language an answer is written in, as the model is told it. A model
// writes in the language of what it read last, and what it reads before an
// answer is often not the user's own words: a lyric line they quoted, titles
// and lyrics a tool returned, earlier answers. So the turn does not leave the
// choice to the moment of writing. The text LLM reads the language from the
// user's latest message alone (`readMessageLanguage`), and the app states it
// where the model reads last: after that message, and after every tool result.

import type { LlmTool } from '@liedmotif/providers';
import type { AssistantMessage } from '@liedmotif/shared';

/** How the app's line opens. An answer is shown without any line that opens so (`withoutAppRecords`). */
export const ANSWER_LANGUAGE_OPENER = '[Answer language, set by the app:';

/** The app's line for `language`, a language by its English name. */
export const answerLanguageLine = (language: string) =>
  `${ANSWER_LANGUAGE_OPENER} ${language}. Write the answer in ${language}, whatever language the names, titles and lyrics around it are in.]`;

const followedBy = (text: string, line: string) => `${text}\n\n${line}`;

type Turn = { messages: readonly AssistantMessage[]; tools: readonly LlmTool[] };

/**
 * The conversation and the tools of one turn that is answered in `language`:
 * the last message, which is the user's, and whatever a tool returns are each
 * followed by the app's line. Without a language both are as they were, and
 * the model goes by the conversation.
 */
export function answeredIn(language: string, { messages, tools }: Turn): Turn {
  if (!language) return { messages, tools };
  const line = answerLanguageLine(language);
  return {
    messages: messages.map((message, index) =>
      index === messages.length - 1
        ? { ...message, content: followedBy(message.content, line) }
        : message,
    ),
    tools: tools.map((tool) => ({
      ...tool,
      execute: async (input: unknown) => followedBy(await tool.execute(input), line),
    })),
  };
}
