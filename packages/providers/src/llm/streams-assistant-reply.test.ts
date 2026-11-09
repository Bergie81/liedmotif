import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '../errors';
import { scriptedLanguageModel, type ScriptedModelStep } from '../testing';
import type { LlmTool } from './index';
import { createOllamaLlmProvider, createOpenRouterLlmProvider } from './openai-compatible';

/** A lookup tool that records what it was asked and answers from a table. */
function lookupTool(answers: Record<string, string>) {
  const asked: string[] = [];
  const tool: LlmTool<{ topic: string }> = {
    name: 'lookup',
    description: 'Look a topic up.',
    inputSchema: z.object({ topic: z.string() }),
    async execute({ topic }) {
      asked.push(topic);
      return answers[topic] ?? 'Nothing on that.';
    },
  };
  return { tool, asked };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** What a provider's rejection looks like coming out of the SDK. */
const RAW_API_ERROR = Object.assign(new Error('401 {"error":"raw body with sk-secret-key"}'), {
  name: 'AI_APICallError',
  statusCode: 401,
});

/** Run a reply to its end: the chunks that arrived, and the error that ended it. */
async function replyOutcome(
  steps: ScriptedModelStep[],
  options: { baseUrl?: string; requestTimeoutMs?: number; signal?: AbortSignal } = {},
) {
  const { signal, ...config } = options;
  const model = scriptedLanguageModel(steps);
  const provider = createOpenRouterLlmProvider({
    apiKey: 'sk-or-1',
    model: 'm',
    languageModel: model,
    ...config,
  });
  const chunks: string[] = [];
  let error: unknown;
  try {
    for await (const chunk of provider.streamAssistantReply({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxToolSteps: 4,
      ...(signal ? { signal } : {}),
    })) {
      chunks.push(chunk);
    }
  } catch (caught) {
    error = caught;
  }
  return { chunks, error, model };
}

describe('streamAssistantReply (OpenAI-compatible adapter)', () => {
  it('lets the model read through a tool, then streams its answer', async () => {
    const model = scriptedLanguageModel([
      { toolCalls: [{ name: 'lookup', input: { topic: 'invites' } }] },
      { text: ['Create an ', 'invite link.'] },
    ]);
    const { tool, asked } = lookupTool({ invites: 'Invites are made under Members.' });
    const provider = createOpenRouterLlmProvider({ apiKey: 'k', model: 'm', languageModel: model });

    const chunks = await collect(
      provider.streamAssistantReply({
        system: 'You are the helper.',
        messages: [{ role: 'user', content: 'How do I invite someone?' }],
        tools: [tool],
        maxToolSteps: 4,
      }),
    );

    expect(chunks).toEqual(['Create an ', 'invite link.']);
    expect(asked).toEqual(['invites']);
    expect(model.doStreamCalls).toHaveLength(2);
    // The system prompt leads every call, and the tool's answer is what the
    // second call adds.
    const [first, second] = model.doStreamCalls.map((call) => JSON.stringify(call.prompt));
    expect(first).toMatch(/^\[\{"role":"system","content":"You are the helper\."/);
    expect(first).toContain('How do I invite someone?');
    expect(first).not.toContain('Invites are made under Members.');
    expect(second).toMatch(/^\[\{"role":"system","content":"You are the helper\."/);
    expect(second).toContain('Invites are made under Members.');
  });

  it('takes the tools away once the tool steps are used, so the model has to answer', async () => {
    const model = scriptedLanguageModel([
      { toolCalls: [{ name: 'lookup', input: { topic: 'a' } }] },
      { toolCalls: [{ name: 'lookup', input: { topic: 'b' } }] },
      { text: ['Here is what I found.'] },
    ]);
    const { tool, asked } = lookupTool({});
    const provider = createOpenRouterLlmProvider({ apiKey: 'k', model: 'm', languageModel: model });

    const chunks = await collect(
      provider.streamAssistantReply({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [tool],
        maxToolSteps: 2,
      }),
    );

    expect(chunks.join('')).toBe('Here is what I found.');
    expect(asked).toEqual(['a', 'b']);
    expect(model.doStreamCalls.map((call) => call.tools?.length ?? 0)).toEqual([1, 1, 0]);
  });

  it('keeps what the model says before a tool call apart from its answer', async () => {
    const model = scriptedLanguageModel([
      { say: 'Let me check.', toolCalls: [{ name: 'lookup', input: { topic: 'a' } }] },
      { text: ['Open ', 'Settings.'] },
    ]);
    const provider = createOpenRouterLlmProvider({ apiKey: 'k', model: 'm', languageModel: model });

    const chunks = await collect(
      provider.streamAssistantReply({
        system: 's',
        messages: [{ role: 'user', content: 'q' }],
        tools: [lookupTool({}).tool],
        maxToolSteps: 4,
      }),
    );

    expect(chunks.join('')).toBe('Let me check.\n\nOpen Settings.');
  });

  it('turns a refused call into a sanitized error and prints nothing raw', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { chunks, error } = await replyOutcome([{ fail: RAW_API_ERROR }]);

    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    const failure = error as ProviderError;
    expect(failure.safeDetail).toEqual({ errorName: 'AI_APICallError', statusCode: 401 });
    expect(failure.message).not.toContain('sk-secret-key');
    expect(printed).not.toHaveBeenCalled();
    printed.mockRestore();
  });

  it('ends an answer that breaks off mid-stream with the same sanitized error', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { chunks, error } = await replyOutcome([{ text: ['Open '], thenFail: RAW_API_ERROR }]);

    expect(chunks).toEqual(['Open ']);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).not.toContain('sk-secret-key');
    expect(printed).not.toHaveBeenCalled();
    printed.mockRestore();
  });

  it('refuses to reach a private host before any model call', async () => {
    const { error, model } = await replyOutcome([{ text: ['never'] }], {
      baseUrl: 'http://10.0.0.5/v1',
    });

    expect(error).toBeInstanceOf(ProviderError);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('gives up on a model call that overruns the configured timeout, with the slow-model message', async () => {
    const { error } = await replyOutcome([{ hang: true }], { requestTimeoutMs: 20 });

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain('took too long');
    expect((error as ProviderError).safeDetail?.timedOut).toBe(true);
  });

  it('gives up the same way on an answer that stalls halfway', async () => {
    const { chunks, error } = await replyOutcome([{ text: ['Open '], thenHang: true }], {
      requestTimeoutMs: 20,
    });

    expect(chunks).toEqual(['Open ']);
    expect((error as ProviderError).safeDetail?.timedOut).toBe(true);
  });

  it('stops the model call when the caller gives up', async () => {
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 10);

    const { error, model } = await replyOutcome([{ hang: true }], { signal: caller.signal });

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).safeDetail?.timedOut).toBeUndefined();
    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });
});

describe('streamAssistantReply on the wire (real SDK model, stubbed transport)', () => {
  const chunk = (delta: unknown, finishReason: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'qwen',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const TOOL_CALL = {
    index: 0,
    id: 'call_1',
    type: 'function',
    function: { name: 'lookup', arguments: '{"topic":"invites"}' },
  };
  const REPLIES = [
    [chunk({ role: 'assistant', tool_calls: [TOOL_CALL] }), chunk({}, 'tool_calls')],
    [
      chunk({ role: 'assistant', content: 'Create an ' }),
      chunk({ content: 'invite link.' }, 'stop'),
    ],
  ];

  it('offers the tools to an Ollama model and returns what they answer, over the configured transport', async () => {
    const requests: Array<{ url: string; redirect?: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        redirect: init?.redirect,
        body: JSON.parse(String(init?.body)),
      });
      const reply = REPLIES[requests.length - 1] ?? [];
      return new Response(`${reply.join('')}data: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const { tool } = lookupTool({ invites: 'Invites are made under Members.' });
    const provider = createOllamaLlmProvider({ model: 'qwen', fetchImpl });

    const chunks = await collect(
      provider.streamAssistantReply({
        system: 'You are the helper.',
        messages: [{ role: 'user', content: 'How do I invite someone?' }],
        tools: [tool],
        maxToolSteps: 4,
      }),
    );

    expect(chunks.join('')).toBe('Create an invite link.');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(request.redirect).toBe('manual');
      expect(request.body.stream).toBe(true);
      expect(request.body.tools).toMatchObject([
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look a topic up.',
            parameters: { type: 'object', properties: { topic: { type: 'string' } } },
          },
        },
      ]);
    }
    expect(requests[0]?.body.messages).toMatchObject([
      { role: 'system', content: 'You are the helper.' },
      { role: 'user', content: 'How do I invite someone?' },
    ]);
    expect(requests[1]?.body.messages).toMatchObject([
      { role: 'system' },
      { role: 'user' },
      { role: 'assistant' },
      { role: 'tool', tool_call_id: 'call_1', content: 'Invites are made under Members.' },
    ]);
  });
});
