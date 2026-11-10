// One Assistant turn in which the model calls tools: a scripted model stands
// in for the text LLM, the route runs for real, and what each tool returned is
// read off what that model was sent next.

import { expect } from 'vitest';
import { createOpenRouterLlmProvider, type LlmProvider } from '@liedmotif/providers';
import { scriptedLanguageModel } from '@liedmotif/providers/testing';
import {
  createAssistantStreamDecoder,
  type AssistantPlayerState,
  type AssistantStreamEvent,
} from '@liedmotif/shared';

interface ToolCall {
  name: string;
  input: unknown;
}

export interface ToolCallsTurn {
  /** What each tool handed the model, in the order the model called them. */
  results: string[];
  /** The reply stream as the browser reads it. */
  events: AssistantStreamEvent[];
  /** The system prompt the turn opened with. */
  system: string;
}

export interface ToolTurn extends Omit<ToolCallsTurn, 'results'> {
  /** What the tool handed the model. */
  result: string;
}

/**
 * Sends one message through `post`; the model calls every one of `calls` at
 * once and then writes `answer`. `useLlm` hands the route the text LLM of this
 * turn.
 */
export async function askWithToolCalls(
  post: (request: Request) => Promise<Response>,
  useLlm: (llm: LlmProvider) => void,
  calls: ToolCall[],
  { player, answer = ['Here you go.'] }: { player?: AssistantPlayerState; answer?: string[] } = {},
): Promise<ToolCallsTurn> {
  const model = scriptedLanguageModel([{ toolCalls: calls }, { text: answer }]);
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
  const events = createAssistantStreamDecoder().push(await response.text());

  expect(model.doStreamCalls).toHaveLength(2);
  const [first, second] = model.doStreamCalls.map((sent) => sent.prompt);
  const outputs = second!.flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.output] : []))
      : [],
  );
  expect(outputs).toHaveLength(calls.length);
  return {
    results: outputs.map((output) => {
      expect(output).toMatchObject({ type: 'text' });
      return output.type === 'text' ? output.value : '';
    }),
    events,
    system: String(first![0]?.content),
  };
}

/** One turn in which the model calls a single tool. */
export async function askWithToolCall(
  post: (request: Request) => Promise<Response>,
  useLlm: (llm: LlmProvider) => void,
  call: ToolCall,
  player?: AssistantPlayerState,
): Promise<ToolTurn> {
  const { results, ...turn } = await askWithToolCalls(post, useLlm, [call], { player });
  return { ...turn, result: results[0]! };
}
