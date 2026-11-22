// Runs the eval set against a text LLM: every question is one real Assistant
// turn — the app's own system prompt, route map and tools — asked once. The
// user's music is the fixture's, so a run reads and changes nobody's data.

import {
  ProviderError,
  type AssistantReplyInput,
  type LlmProvider,
  type LlmTool,
} from '@liedmotif/providers';
import type { AssistantAction } from '@liedmotif/shared';
import { loadDocs } from '../docs';
import { answerLinkTargets } from '../link-targets';
import { streamAssistantAnswer } from '../reply';
import { createTurnActions } from '../turn-actions';
import type { EvalEntry } from './eval-set';
import { fixtureTools } from './fixture';
import { scoreAnswer, type AnswerScore, type ObservedToolCall, type ObservedTurn } from './score';

/** How long one question may take, tool steps included, before it counts as failed. */
const QUESTION_TIMEOUT_MS = 10 * 60_000;

/** What the model was sent during one turn, in characters. */
export interface PromptChars {
  system: number;
  /** The question and the earlier turns that fit the history budget. */
  conversation: number;
  /** Everything the turn's tools returned: docs sections, lookups, what an action came to. */
  toolResults: number;
}

export interface EvalResult {
  entry: EvalEntry;
  turn: ObservedTurn;
  score: AnswerScore;
  promptChars: PromptChars;
  /** From sending the question to the end of the answer. */
  ms: number;
}

/**
 * Asks every entry once, one after the other. A question that fails or runs out
 * of time is recorded as failed and never asked again; the run goes on.
 */
export async function runEval(
  llm: LlmProvider,
  entries: readonly EvalEntry[],
  options: { timeoutMs?: number; onResult?: (result: EvalResult) => void } = {},
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const entry of entries) {
    const result = await ask(llm, entry, options.timeoutMs ?? QUESTION_TIMEOUT_MS);
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}

async function ask(llm: LlmProvider, entry: EvalEntry, timeoutMs: number): Promise<EvalResult> {
  const observed = observe(llm);
  const signal = AbortSignal.timeout(timeoutMs);
  const actions: AssistantAction[] = [];
  const messages = [...(entry.history ?? []), { role: 'user' as const, content: entry.question }];
  const started = performance.now();
  let answer = '';
  let error: string | undefined;
  try {
    const tools = fixtureTools(
      entry.role,
      createTurnActions((action) => actions.push(action)),
      { nothingPlaying: entry.nothingPlaying },
    );
    for await (const chunk of streamAssistantAnswer(
      observed.llm,
      { role: entry.role },
      observed.tools(tools),
      messages,
      signal,
    )) {
      answer += chunk;
    }
  } catch (err) {
    // A `ProviderError` message is sanitized by the adapter; anything else may
    // quote the provider, so it is not repeated.
    if (signal.aborted) error = `No answer within ${timeoutMs / 1000} s.`;
    else if (err instanceof ProviderError) error = err.message;
    else error = 'The turn failed unexpectedly.';
  }
  const ms = Math.round(performance.now() - started);

  const turn: ObservedTurn = {
    answer,
    toolCalls: observed.toolCalls,
    actions,
    ...(error === undefined ? {} : { error }),
  };
  return {
    entry,
    turn,
    score: scoreAnswer(entry, turn, {
      pages: loadDocs(),
      targets: answerLinkTargets(entry.role),
    }),
    promptChars: {
      ...observed.sent,
      toolResults: observed.toolCalls.reduce((sum, { result }) => sum + result.length, 0),
    },
    ms,
  };
}

/**
 * One turn made visible: what the provider was sent, and each tool call with
 * what the app's tool returned for it. The model sees no difference.
 */
function observe(llm: LlmProvider): {
  llm: LlmProvider;
  tools: (tools: readonly LlmTool[]) => LlmTool[];
  toolCalls: ObservedToolCall[];
  sent: { system: number; conversation: number };
} {
  const toolCalls: ObservedToolCall[] = [];
  const sent = { system: 0, conversation: 0 };
  return {
    toolCalls,
    sent,
    tools: (tools) =>
      tools.map((tool) => ({
        ...tool,
        async execute(toolInput: unknown) {
          const result = await tool.execute(toolInput);
          toolCalls.push({ name: tool.name, input: toolInput, result });
          return result;
        },
      })),
    llm: {
      ...llm,
      streamAssistantReply(input: AssistantReplyInput) {
        sent.system = input.system.length;
        sent.conversation = input.messages.reduce((sum, { content }) => sum + content.length, 0);
        return llm.streamAssistantReply(input);
      },
    },
  };
}
