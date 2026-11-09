// The conversation with the Assistant as the browser holds it: what it sends,
// what it shows while an answer arrives, and what is left when an answer does
// not arrive.

import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  assistantRequestSchema,
  encodeAssistantStreamEvent,
  makeApiError,
  type ApiErrorCode,
  type AssistantRequest,
  type AssistantStreamEvent,
} from '@liedmotif/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { createAssistantConversation } from './conversation';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One request the conversation made, answered by the test at its own pace. */
interface Asked {
  request: AssistantRequest;
  signal: AbortSignal;
  /** Opens the reply stream; the returned handle writes its events. */
  reply(): { send(event: AssistantStreamEvent): void; end(): void };
  /** Refuses the request before any answer. */
  refuse(status: number, code: ApiErrorCode, message: string, headers?: HeadersInit): void;
  /** The request never reaches the server. */
  drop(): void;
}

function captureQuestions(): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_path: string, init: { body: string; signal: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          asked.push({
            request: assistantRequestSchema.parse(JSON.parse(init.body)),
            signal: init.signal,
            reply() {
              let stream!: ReadableStreamDefaultController<Uint8Array>;
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  stream = controller;
                },
              });
              resolve(
                new Response(body, { headers: { 'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE } }),
              );
              const encoder = new TextEncoder();
              return {
                send: (event) => stream.enqueue(encoder.encode(encodeAssistantStreamEvent(event))),
                end: () => stream.close(),
              };
            },
            refuse(status, code, message, headers) {
              resolve(Response.json(makeApiError(code, message), { status, headers }));
            },
            drop() {
              reject(new TypeError('Failed to fetch'));
            },
          });
        }),
    ),
  );
  return asked;
}

it('shows the answer as it is written', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();

  conversation.send('How do I invite someone?');

  expect(conversation.getState()).toMatchObject({
    messages: [
      { role: 'user', content: 'How do I invite someone?' },
      { role: 'assistant', content: '' },
    ],
    answering: true,
  });
  expect(asked[0]!.request.messages).toEqual([
    { role: 'user', content: 'How do I invite someone?' },
  ]);

  const reply = asked[0]!.reply();
  reply.send({ type: 'text', text: 'Open **Settings' });
  await vi.waitFor(() =>
    expect(conversation.getState().messages.at(-1)?.content).toBe('Open **Settings'),
  );
  expect(conversation.getState().answering).toBe(true);

  reply.send({ type: 'text', text: ' › Members**.' });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  expect(conversation.getState().messages.at(-1)).toEqual({
    role: 'assistant',
    content: 'Open **Settings › Members**.',
  });
  expect(conversation.getState().notice).toBeNull();
});

/** Asks, and has the Assistant answer in full. */
async function exchange(
  conversation: ReturnType<typeof createAssistantConversation>,
  asked: Asked[],
  question: string,
  answer: string,
): Promise<void> {
  conversation.send(question);
  const reply = asked.at(-1)!.reply();
  reply.send({ type: 'text', text: answer });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
}

it('sends only the last 12 messages of a long conversation', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  for (let turn = 1; turn <= 7; turn += 1) {
    await exchange(conversation, asked, `question ${turn}`, `answer ${turn}`);
  }

  conversation.send('question 8');

  expect(conversation.getState().messages).toHaveLength(16);
  const sent = asked.at(-1)!.request.messages;
  expect(sent).toHaveLength(12);
  expect(sent[0]).toEqual({ role: 'assistant', content: 'answer 2' });
  expect(sent.at(-1)).toEqual({ role: 'user', content: 'question 8' });
});

it('clips a long earlier answer to what one message may carry', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  await exchange(conversation, asked, 'Tell me everything.', 'x'.repeat(4500));

  conversation.send('And then?');

  expect(conversation.getState().messages[1]!.content).toHaveLength(4500);
  expect(asked.at(-1)!.request.messages[1]!.content).toBe('x'.repeat(4000));
});

it('sends what is typed and empties the field', () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.setDraft('  How do I listen offline?  ');

  conversation.send();

  expect(asked[0]!.request.messages).toEqual([
    { role: 'user', content: 'How do I listen offline?' },
  ]);
  expect(conversation.getState().draft).toBe('');
});

it('asks nothing when nothing is typed', () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.setDraft('   ');

  conversation.send();

  expect(asked).toHaveLength(0);
  expect(conversation.getState().messages).toEqual([]);
});

it.each([
  {
    refusal: 'a burst of questions',
    status: 429,
    code: 'rate_limited',
    headers: { 'Retry-After': '40' },
    notice: 'That was a lot of questions at once. Try again in 40 seconds.',
  },
  {
    refusal: 'a long wait after a burst',
    status: 429,
    code: 'rate_limited',
    headers: { 'Retry-After': '170' },
    notice: 'That was a lot of questions at once. Try again in 3 minutes.',
  },
  {
    refusal: 'no Writing AI',
    status: 503,
    code: 'assistant_unavailable',
    headers: undefined,
    notice: 'Mo is not available: no Writing AI is set up.',
  },
  {
    refusal: 'a Writing AI that failed',
    status: 502,
    code: 'provider_error',
    headers: undefined,
    notice: 'The server said why.',
  },
  {
    refusal: 'an ended sign-in',
    status: 401,
    code: 'unauthorized',
    headers: undefined,
    notice: 'You are signed out. Sign in again to keep asking.',
  },
] as const)(
  'says why after $refusal, and gives the typed message back',
  async ({ status, code, headers, notice }) => {
    const asked = captureQuestions();
    const conversation = createAssistantConversation();
    await exchange(conversation, asked, 'What is a Session?', 'Continuous music.');
    conversation.setDraft('How do I invite someone?');

    conversation.send();
    asked.at(-1)!.refuse(status, code, 'The server said why.', headers);

    await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
    expect(conversation.getState()).toEqual({
      messages: [
        { role: 'user', content: 'What is a Session?' },
        { role: 'assistant', content: 'Continuous music.' },
      ],
      answering: false,
      draft: 'How do I invite someone?',
      notice,
    });
  },
);

it('says so when the server cannot be reached, and gives the typed message back', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.setDraft('How do I invite someone?');

  conversation.send();
  asked[0]!.drop();

  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  expect(conversation.getState()).toEqual({
    messages: [],
    answering: false,
    draft: 'How do I invite someone?',
    notice: 'Could not reach the server. Try again.',
  });
});

it('clears the notice with the next question', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('How do I invite someone?');
  asked[0]!.drop();
  await vi.waitFor(() => expect(conversation.getState().notice).not.toBeNull());

  conversation.send();

  expect(conversation.getState().notice).toBeNull();
  expect(asked).toHaveLength(2);
});

it('keeps what was written when the answer fails part-way', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.setDraft('How do I invite someone?');
  conversation.send();

  const reply = asked[0]!.reply();
  reply.send({ type: 'text', text: 'Open **Settings' });
  reply.send({
    type: 'error',
    error: makeApiError('provider_error', 'The Writing AI stopped answering. Try again.', true)
      .error,
  });

  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  expect(conversation.getState()).toEqual({
    messages: [
      { role: 'user', content: 'How do I invite someone?' },
      { role: 'assistant', content: 'Open **Settings' },
    ],
    answering: false,
    draft: '',
    notice: 'The Writing AI stopped answering. Try again.',
  });
});

it('reports an answer whose connection dropped before it was finished', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('How do I invite someone?');

  const reply = asked[0]!.reply();
  reply.send({ type: 'text', text: 'Open' });
  reply.end();

  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  expect(conversation.getState().messages.at(-1)).toEqual({ role: 'assistant', content: 'Open' });
  expect(conversation.getState().notice).toBe(
    'The connection was lost before the answer was finished. Try again.',
  );
});

it('stops a running answer and keeps what was written', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('How do I invite someone?');
  const reply = asked[0]!.reply();
  reply.send({ type: 'text', text: 'Open **Settings' });
  await vi.waitFor(() => expect(conversation.getState().messages.at(-1)?.content).not.toBe(''));

  conversation.stop();

  expect(asked[0]!.signal.aborted).toBe(true);
  expect(conversation.getState()).toEqual({
    messages: [
      { role: 'user', content: 'How do I invite someone?' },
      { role: 'assistant', content: 'Open **Settings' },
    ],
    answering: false,
    draft: '',
    notice: null,
  });

  // Whatever still arrives belongs to the answer that was stopped.
  reply.send({ type: 'text', text: ' › Members**.' });
  reply.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(conversation.getState().messages.at(-1)?.content).toBe('Open **Settings');
  expect(conversation.getState().notice).toBeNull();
});

it('gives the typed message back when stopped before any answer', () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.setDraft('How do I invite someone?');
  conversation.send();

  conversation.stop();

  expect(asked[0]!.signal.aborted).toBe(true);
  expect(conversation.getState()).toEqual({
    messages: [],
    answering: false,
    draft: 'How do I invite someone?',
    notice: null,
  });
});

it('takes one question at a time', () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('How do I invite someone?');

  conversation.setDraft('And offline?');
  conversation.send();

  expect(asked).toHaveLength(1);
  expect(conversation.getState().draft).toBe('And offline?');
});

it('starts over with New chat, ending an answer still being written', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  await exchange(conversation, asked, 'What is a Session?', 'Continuous music.');
  conversation.send('How do I invite someone?');
  const reply = asked.at(-1)!.reply();
  reply.send({ type: 'text', text: 'Open' });
  await vi.waitFor(() => expect(conversation.getState().messages.at(-1)?.content).toBe('Open'));

  conversation.newChat();

  expect(asked.at(-1)!.signal.aborted).toBe(true);
  expect(conversation.getState()).toMatchObject({ messages: [], answering: false, notice: null });

  conversation.send('How do I listen offline?');
  expect(asked.at(-1)!.request.messages).toEqual([
    { role: 'user', content: 'How do I listen offline?' },
  ]);
});

it('starts over with New chat without handing back a question that has no answer yet', () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('How do I invite someone?');

  conversation.newChat();

  expect(asked[0]!.signal.aborted).toBe(true);
  expect(conversation.getState()).toEqual({
    messages: [],
    answering: false,
    draft: '',
    notice: null,
  });
});
