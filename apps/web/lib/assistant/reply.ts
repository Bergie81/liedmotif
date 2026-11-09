// One Assistant turn (server-only): the conversation goes to the text LLM with
// the system prompt and the docs tool, and the answer comes back as text.

import type { UserRole } from '@liedmotif/db';
import type { LlmProvider } from '@liedmotif/providers';
import type { AssistantMessage } from '@liedmotif/shared';
import { buildDocsIndex, loadDocs } from './docs';
import { fitHistory } from './history';
import { buildAssistantSystemPrompt } from './prompt';
import { createReadDocsTool } from './read-docs-tool';

/** Model calls one turn may spend on reading docs before it has to answer. */
const MAX_TOOL_STEPS = 4;

/**
 * The answer to a conversation, as chunks of Markdown in the order the model
 * writes them. Iterating throws the provider's sanitized `ProviderError` when
 * the text LLM fails. The docs sections the model reads stay inside the turn.
 * `role` is the asking user's: it decides which pages of the app the model is
 * told about.
 */
export function streamAssistantAnswer(
  llm: LlmProvider,
  role: UserRole,
  messages: readonly AssistantMessage[],
  signal: AbortSignal,
): AsyncIterable<string> {
  const pages = loadDocs();
  return llm.streamAssistantReply({
    system: buildAssistantSystemPrompt({ role, docsIndex: buildDocsIndex(pages) }),
    messages: fitHistory(messages),
    tools: [createReadDocsTool(pages)],
    maxToolSteps: MAX_TOOL_STEPS,
    signal,
  });
}
