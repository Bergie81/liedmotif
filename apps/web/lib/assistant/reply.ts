// One Assistant turn (server-only): the conversation goes to the text LLM with
// the system prompt and the turn's tools, and the answer comes back as text.

import type { UserRole } from '@liedmotif/db';
import type { LlmProvider, LlmTool } from '@liedmotif/providers';
import type { AssistantMessage } from '@liedmotif/shared';
import { buildDocsIndex, loadDocs } from './docs';
import { fitHistory } from './history';
import { buildAssistantSystemPrompt } from './prompt';

/** Model calls one turn may spend on tools before it has to answer. */
const MAX_TOOL_STEPS = 4;

/**
 * The answer to a conversation, as chunks of Markdown in the order the model
 * writes them. Iterating throws the provider's sanitized `ProviderError` when
 * the text LLM fails. What the tools return stays inside the turn. `role` is
 * the asking user's: it decides which pages of the app the model is told
 * about. `tools` are this turn's own (`createAssistantTools`).
 */
export function streamAssistantAnswer(
  llm: LlmProvider,
  role: UserRole,
  tools: readonly LlmTool[],
  messages: readonly AssistantMessage[],
  signal: AbortSignal,
): AsyncIterable<string> {
  return llm.streamAssistantReply({
    system: buildAssistantSystemPrompt({ role, docsIndex: buildDocsIndex(loadDocs()) }),
    messages: fitHistory(messages),
    tools,
    maxToolSteps: MAX_TOOL_STEPS,
    signal,
  });
}
