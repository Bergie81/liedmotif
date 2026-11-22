// One Assistant turn (server-only): the conversation goes to the text LLM with
// the system prompt and the turn's tools, and the answer comes back as text.
// The language of that answer is read first, in a call of its own.

import type { UserRole } from '@liedmotif/db';
import type { LlmProvider, LlmTool } from '@liedmotif/providers';
import type { AssistantMessage } from '@liedmotif/shared';
import { answeredIn } from './answer-language';
import { withoutAppRecords } from './app-records';
import { buildDocsIndex, loadDocs } from './docs';
import { fitHistory } from './history';
import { buildAssistantSystemPrompt } from './prompt';

/** Model calls one turn may spend on tools before it has to answer. */
const MAX_TOOL_STEPS = 4;

/**
 * The answer to a conversation, as chunks of Markdown in the order the model
 * writes them, without any record of the app's that the model copied from an
 * earlier answer. Before the answer, the text LLM reads which language the
 * user's latest message is written in, from that message alone, and the turn
 * names it to the model (`answeredIn`). Iterating throws the provider's
 * sanitized `ProviderError` when the text LLM fails. What the tools return
 * stays inside the turn. `role` is the asking user's: it decides which pages of
 * the app the model is told about. `tone` is the tone they gave the Assistant;
 * without one the model answers in the default voice. `tools` are this turn's
 * own (`createAssistantTools`).
 */
export async function* streamAssistantAnswer(
  llm: LlmProvider,
  { role, tone }: { role: UserRole; tone?: string },
  tools: readonly LlmTool[],
  messages: readonly AssistantMessage[],
  signal: AbortSignal,
): AsyncIterable<string> {
  const conversation = fitHistory(messages);
  // A call of its own: the reply is streamed free text, with no answer field
  // that could carry the language.
  const language = await llm.readMessageLanguage({
    text: conversation.at(-1)?.content ?? '',
    signal,
  });
  yield* withoutAppRecords(
    llm.streamAssistantReply({
      system: buildAssistantSystemPrompt({ role, tone, docsIndex: buildDocsIndex(loadDocs()) }),
      ...answeredIn(language, { messages: conversation, tools }),
      maxToolSteps: MAX_TOOL_STEPS,
      signal,
    }),
  );
}
