import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '../errors';
import { scriptedLanguageModel, type ScriptedModelStep } from '../testing';
import type { LlmProvider, LlmTool } from './index';
import {
  createOllamaLlmProvider,
  createOpenAiLlmProvider,
  createOpenRouterLlmProvider,
} from './openai-compatible';

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

  it('ends an answer the provider cut short with an error, never as a finished answer', async () => {
    const { chunks, error } = await replyOutcome([
      { text: ['Open the settings and'], thenCutOff: 'length' },
    ]);

    expect(chunks).toEqual(['Open the settings and']);
    expect(error).toBeInstanceOf(ProviderError);
    const failure = error as ProviderError;
    expect(failure.message).toBe(
      'The Writing AI stopped before the answer was finished. Try again.',
    );
    expect(failure.safeDetail).toEqual({ finishReason: 'length' });
  });

  it('treats an answer the provider withheld part of the same way', async () => {
    const { error } = await replyOutcome([{ text: ['Open '], thenCutOff: 'content-filter' }]);

    expect((error as ProviderError).safeDetail).toEqual({ finishReason: 'content-filter' });
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

  /** What a Session expansion gets back: one whole chat completion, not a stream. */
  const EXPANSION_REPLY = {
    id: 'chatcmpl-2',
    object: 'chat.completion',
    created: 1,
    model: 'qwen',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            stylePrompt: 'mellow lofi beats',
            genreTags: ['lofi'],
            vocalMode: 'instrumental',
          }),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  /**
   * A `fetch` that records each request and answers it as the endpoint would:
   * a streamed call with the next of `REPLIES`, any other with a completion.
   */
  function stubWire() {
    const requests: Array<{ url: string; redirect?: string; body: Record<string, unknown> }> = [];
    let streamed = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), redirect: init?.redirect, body });
      if (body.stream !== true) return Response.json(EXPANSION_REPLY);
      const reply = REPLIES[streamed] ?? [];
      streamed += 1;
      return new Response(`${reply.join('')}data: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, requests };
  }

  function askOverTheWire(provider: LlmProvider): Promise<string[]> {
    return collect(
      provider.streamAssistantReply({
        system: 'You are the helper.',
        messages: [{ role: 'user', content: 'How do I invite someone?' }],
        tools: [lookupTool({ invites: 'Invites are made under Members.' }).tool],
        maxToolSteps: 4,
      }),
    );
  }

  it('offers the tools to an Ollama model and returns what they answer, over the configured transport', async () => {
    const { fetchImpl, requests } = stubWire();
    const provider = createOllamaLlmProvider({ model: 'qwen', fetchImpl });

    const chunks = await askOverTheWire(provider);

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

  it('asks hosted OpenAI with reasoning off, and leaves a Session expansion at the configured effort', async () => {
    // Its chat-completions endpoint answers 400 to function tools sent with any
    // reasoning effort but `none`; the preset's default effort is `high`.
    const { fetchImpl, requests } = stubWire();
    const provider = createOpenAiLlmProvider({ apiKey: 'sk-oai-1', fetchImpl });

    const chunks = await askOverTheWire(provider);
    await provider.expandSessionIntent('chill study music');

    expect(chunks.join('')).toBe('Create an invite link.');
    const asked = requests.filter((request) => request.body.stream === true);
    const expanded = requests.filter((request) => request.body.stream !== true);
    expect(asked).toHaveLength(2);
    for (const { body } of asked) {
      expect(body.tools).toHaveLength(1);
      expect(body.reasoning_effort).toBe('none');
    }
    expect(expanded.length).toBeGreaterThan(0);
    for (const { body } of expanded) {
      expect(body).not.toHaveProperty('tools');
      expect(body.reasoning_effort).toBe('high');
    }
  });

  it('names no reasoning effort to an OpenAI model configured without one', async () => {
    // A model picked by hand may not know the field at all.
    const { fetchImpl, requests } = stubWire();
    const provider = createOpenAiLlmProvider({ apiKey: 'sk-oai-1', model: 'plain', fetchImpl });

    await askOverTheWire(provider);

    expect(requests).toHaveLength(2);
    for (const { body } of requests) expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('keeps the configured effort where the endpoint takes it with tools', async () => {
    const { fetchImpl, requests } = stubWire();
    const provider = createOllamaLlmProvider({ model: 'qwen', reasoningEffort: 'low', fetchImpl });

    await askOverTheWire(provider);

    expect(requests).toHaveLength(2);
    for (const { body } of requests) expect(body.reasoning_effort).toBe('low');
  });
});
