// One Assistant turn in which the model calls a single tool: a scripted model
// stands in for the text LLM, the route runs for real, and what the tool
// returned is read off what that model was sent next.

import { expect } from 'vitest';
import { createOpenRouterLlmProvider, type LlmProvider } from '@liedmotif/providers';
import { scriptedLanguageModel } from '@liedmotif/providers/testing';
import type { AssistantPlayerState } from '@liedmotif/shared';

export interface ToolTurn {
  /** What the tool handed the model. */
  result: string;
  /** The system prompt the turn opened with. */
  system: string;
}

/**
 * Sends one message through `post`; the model calls `call` once and then
 * answers. `useLlm` hands the route the text LLM of this turn.
 */
export async function askWithToolCall(
  post: (request: Request) => Promise<Response>,
  useLlm: (llm: LlmProvider) => void,
  call: { name: string; input: unknown },
  player?: AssistantPlayerState,
): Promise<ToolTurn> {
  const model = scriptedLanguageModel([{ toolCalls: [call] }, { text: ['Here you go.'] }]);
  useLlm(
    createOpenRouterLlmProvider({
      apiKey: 'sk-or-test-key',
      model: 'test-model',
      languageModel: model,
    }),
  );

  const response = await post(
    new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Look it up.' }], player }),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();

  expect(model.doStreamCalls).toHaveLength(2);
  const [first, second] = model.doStreamCalls.map((sent) => sent.prompt);
  const results = second!.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.output] : []))
      : [],
  );
  expect(results).toHaveLength(1);
  const [output] = results;
  expect(output).toMatchObject({ type: 'text' });
  return {
    result: output?.type === 'text' ? output.value : '',
    system: String(first![0]?.content),
  };
}
