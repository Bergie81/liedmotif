import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  assistantStreamEventSchema,
  errorResponseSchema,
  type AssistantMessage,
  type AssistantStreamEvent,
} from '@liedmotif/shared';
import { createOpenRouterLlmProvider, type LlmProvider } from '@liedmotif/providers';
import { scriptedLanguageModel, type ScriptedModelStep } from '@liedmotif/providers/testing';
import { loadDocs } from '@/lib/assistant/docs';

// The Assistant end to end, short of the network: the route, the system prompt,
// the docs tool and the text-LLM adapter, with a scripted model standing in for
// the provider's.

const holder = vi.hoisted(() => ({
  userId: null as string | null,
  llm: null as unknown,
}));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
}));
vi.mock('@/lib/providers', () => ({ getLlmProvider: async () => holder.llm }));
// No database here: every asker is the Admin, whose messages are held to no
// daily allowance and so read and count nothing.
vi.mock('@/lib/db', () => ({ getDb: () => null }));
vi.mock('@/lib/request-cache', () => ({
  cachedUserProfile: async () => ({ role: 'admin', disabledAt: null }),
}));

const { POST } = await import('@/app/api/assistant/route');

/** Configure a text LLM whose model follows the script; returns the model to inspect. */
function scriptModel(steps: ScriptedModelStep[]) {
  const model = scriptedLanguageModel(steps);
  holder.llm = createOpenRouterLlmProvider({
    apiKey: 'sk-or-test-key',
    model: 'test-model',
    languageModel: model,
  }) satisfies LlmProvider;
  return model;
}

function send(messages: AssistantMessage[], signal?: AbortSignal): Promise<Response> {
  return POST(
    new Request('http://localhost/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      ...(signal ? { signal } : {}),
    }),
  );
}

function ask(question: string): Promise<Response> {
  return send([{ role: 'user', content: question }]);
}

async function readEvents(response: Response): Promise<AssistantStreamEvent[]> {
  const frames = (await response.text()).split('\n\n').filter(Boolean);
  return frames.map((frame) => {
    expect(frame.startsWith('data: ')).toBe(true);
    return assistantStreamEventSchema.parse(JSON.parse(frame.slice('data: '.length)));
  });
}

function answerOf(events: AssistantStreamEvent[]): string {
  return events.map((event) => (event.type === 'text' ? event.text : '')).join('');
}

/** What each model call was sent, as one searchable string per call. */
function promptsOf(model: ReturnType<typeof scriptedLanguageModel>): string[] {
  return model.doStreamCalls.map((call) => JSON.stringify(call.prompt));
}

/** A real section of the docs snapshot, whatever the docs currently hold. */
function someDocsSection() {
  const page = loadDocs().find((candidate) => candidate.sections.length > 1)!;
  const section = page.sections.at(-1)!;
  return { page: page.slug, section: section.heading, markdown: section.markdown };
}

/** A provider rejection as the SDK raises it: the body and the key ride on the message. */
const RAW_PROVIDER_ERROR = Object.assign(
  new Error('401 {"error":"raw provider body"} for key sk-or-test-key'),
  { name: 'AI_APICallError', statusCode: 401 },
);

/** Everything the server logged during a test, one string. */
let logged = '';

beforeEach(() => {
  // A fresh user per test: the burst limit is counted per user.
  holder.userId = randomUUID();
  holder.llm = null;
  logged = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    logged += String(line);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/assistant', () => {
  it('lets the model read a docs section and streams its answer', async () => {
    const docs = someDocsSection();
    const model = scriptModel([
      { toolCalls: [{ name: 'readDocs', input: { page: docs.page, section: docs.section } }] },
      { text: ['Open **Settings › Members** ', 'and create an invite link.'] },
    ]);

    const response = await ask('How do I invite someone?');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(ASSISTANT_STREAM_CONTENT_TYPE);
    const events = await readEvents(response);
    expect(events.map((event) => event.type)).toEqual(['text', 'text', 'done']);
    expect(answerOf(events)).toBe('Open **Settings › Members** and create an invite link.');
    // The section reached the model, on its second call, and nobody else.
    const [first, second] = promptsOf(model);
    const sectionAsSent = JSON.stringify(docs.markdown).slice(1, -1);
    expect(first).not.toContain(sectionAsSent);
    expect(second).toContain(sectionAsSent);
    expect(JSON.stringify(events)).not.toContain(sectionAsSent);
  });

  it('opens every request with the same system prompt, in the persona', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);

    await (await ask('How do I invite someone?')).text();
    await (await ask('Wie lade ich jemanden ein?')).text();

    const systems = model.doStreamCalls.map((call) => call.prompt[0]);
    expect(systems[0]).toMatchObject({ role: 'system' });
    expect(systems[0]).toEqual(systems[1]);
    const system = JSON.stringify(systems[0]);
    expect(system).toContain('You are Mo,');
    expect(system).toContain("Answer in the language of the user's latest message");
    // The docs index: every page is listed for the model to pick from.
    for (const page of loadDocs()) expect(system).toContain(`${page.slug}: `);
  });

  it('refuses a caller who is not signed in', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);
    holder.userId = null;

    const response = await ask('How do I invite someone?');

    expect(response.status).toBe(401);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('unauthorized');
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('says it is unavailable when no text LLM is configured', async () => {
    const response = await ask('How do I invite someone?');

    expect(response.status).toBe(503);
    const { error } = errorResponseSchema.parse(await response.json());
    expect(error.code).toBe('assistant_unavailable');
    expect(error.retryable).toBe(false);
  });

  it('answers a failing text LLM with a sanitized, retryable error', async () => {
    scriptModel([{ fail: RAW_PROVIDER_ERROR }]);

    const response = await ask('How do I invite someone?');

    expect(response.status).toBe(502);
    const body = await response.text();
    const { error } = errorResponseSchema.parse(JSON.parse(body));
    expect(error.code).toBe('provider_error');
    expect(error.retryable).toBe(true);
    expect(body).not.toContain('sk-or-test-key');
    expect(body).not.toContain('raw provider body');
    // The log names the cause and nothing of the conversation or the provider's reply.
    expect(logged).toContain('"statusCode":401');
    expect(logged).not.toContain('How do I invite someone?');
    expect(logged).not.toContain('sk-or-test-key');
    expect(logged).not.toContain('raw provider body');
  });

  it('never passes off an empty reply as an answer', async () => {
    scriptModel([{ text: [] }]);

    const response = await ask('How do I invite someone?');

    expect(response.status).toBe(502);
    const { error } = errorResponseSchema.parse(await response.json());
    expect(error.code).toBe('provider_error');
    expect(error.retryable).toBe(true);
  });

  it('ends an answer that breaks off with an error event, not a done', async () => {
    scriptModel([{ text: ['Open '], thenFail: RAW_PROVIDER_ERROR }]);

    const response = await ask('How do I invite someone?');

    expect(response.status).toBe(200);
    const body = await response.clone().text();
    const events = await readEvents(response);
    expect(events.map((event) => event.type)).toEqual(['text', 'error']);
    expect(events.at(-1)).toMatchObject({ error: { code: 'provider_error', retryable: true } });
    expect(body).not.toContain('sk-or-test-key');
    expect(body).not.toContain('raw provider body');
  });

  it('stops the model call when the reader leaves mid-answer', async () => {
    const model = scriptModel([{ text: ['Open '], thenHang: true }]);

    const response = await ask('How do I invite someone?');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });

  it('stops the model call when the reader leaves before the answer starts, and logs no failure', async () => {
    const model = scriptModel([{ hang: true }]);
    const reader = new AbortController();
    setTimeout(() => reader.abort(), 10);

    await send([{ role: 'user', content: 'How do I invite someone?' }], reader.signal);

    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
    expect(logged).not.toContain('Assistant reply failed');
  });

  it('refuses a burst past 20 messages in the window, for that user only', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);

    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const response = await ask('How do I invite someone?');
      statuses.push(response.status);
      await response.text();
    }

    expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(200));
    expect(statuses[20]).toBe(429);
    const refused = await ask('How do I invite someone?');
    expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/);
    const { error } = errorResponseSchema.parse(await refused.json());
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(model.doStreamCalls).toHaveLength(20);

    holder.userId = randomUUID();
    expect((await ask('How do I invite someone?')).status).toBe(200);
  });

  it('spends none of the burst budget on a request it cannot answer', async () => {
    for (let i = 0; i < 25; i += 1) {
      expect((await ask('How do I invite someone?')).status).toBe(503);
    }
    scriptModel([{ text: ['Sure.'] }]);

    expect((await ask('How do I invite someone?')).status).toBe(200);
  });

  it('gives the model four tool steps, then makes it answer', async () => {
    const docs = someDocsSection();
    const read = {
      toolCalls: [{ name: 'readDocs', input: { page: docs.page, section: 'intro' } }],
    };
    const model = scriptModel([read, read, read, read, { text: ['Here it is.'] }]);

    const events = await readEvents(await ask('Tell me everything.'));

    expect(answerOf(events)).toBe('Here it is.');
    expect(model.doStreamCalls.map((call) => call.tools?.length ?? 0)).toEqual([1, 1, 1, 1, 0]);
  });

  it('sends the model a conversation that opens with the user', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);

    await (
      await send([
        { role: 'assistant', content: 'Open Members.' },
        { role: 'user', content: 'And then?' },
      ])
    ).text();

    expect(model.doStreamCalls[0]?.prompt.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
  });

  it('refuses a conversation longer than 12 messages before any model call', async () => {
    const model = scriptModel([{ text: ['Sure.'] }]);
    const messages = Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'x',
    }));

    const response = await send(messages);

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('validation_error');
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
