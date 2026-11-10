// The conversation with the Assistant as the browser holds it: what it sends,
// what it shows while an answer arrives, and what is left when an answer does
// not arrive.

import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  assistantRequestSchema,
  encodeAssistantStreamEvent,
  makeApiError,
  type ApiErrorCode,
  type AssistantAction,
  type AssistantRequest,
  type AssistantStreamEvent,
} from '@liedmotif/shared';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProposedChatAction } from './card';
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

it('sends what the player has engaged with every message, as it is when the message is sent', async () => {
  const asked = captureQuestions();
  const source = { kind: 'playlist' as const, id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11' };
  let player: AssistantRequest['player'] = {
    source,
    trackId: '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22',
    playing: true,
  };
  const conversation = createAssistantConversation({ getPlayer: () => player });

  await exchange(conversation, asked, 'What is this?', 'Night Drive.');
  expect(asked[0]!.request.player).toEqual(player);

  player = { ...player, playing: false };
  await exchange(conversation, asked, 'And now?', 'Paused.');
  expect(asked[1]!.request.player).toEqual({ ...player, playing: false });

  // Nothing engaged: the request says nothing about the player.
  player = undefined;
  conversation.send('And now?');
  expect(asked[2]!.request).not.toHaveProperty('player');
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

const PLAYLIST_ID = '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11';

/** The receipt for a Playlist the Assistant created. */
const created = (name: string): AssistantAction => ({
  status: 'done',
  receipt: { action: 'createPlaylist', playlist: { id: PLAYLIST_ID, name } },
});
const createdNote = (name: string) =>
  `[Done by the app: created the Playlist "${name}" (id ${PLAYLIST_ID})]`;

it('holds what the Assistant did with the answer it belongs to, and says so the moment it arrives', async () => {
  const asked = captureQuestions();
  const arrived: AssistantAction[] = [];
  const conversation = createAssistantConversation({ onAction: (action) => arrived.push(action) });

  conversation.send('Make a playlist called Sunday.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: created('Sunday') });
  await vi.waitFor(() => expect(arrived).toEqual([created('Sunday')]));
  expect(conversation.getState()).toMatchObject({
    messages: [{ role: 'user' }, { role: 'assistant', content: '', actions: [created('Sunday')] }],
    answering: true,
  });

  reply.send({ type: 'text', text: 'Done.' });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  expect(conversation.getState().messages.at(-1)).toEqual({
    role: 'assistant',
    content: 'Done.',
    actions: [created('Sunday')],
  });
  expect(arrived).toHaveLength(1);
});

it('keeps an answer that is an action and no text', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();

  conversation.send('Make a playlist called Sunday.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: created('Sunday') });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));

  expect(conversation.getState()).toMatchObject({
    messages: [
      { role: 'user', content: 'Make a playlist called Sunday.' },
      { role: 'assistant', content: '', actions: [created('Sunday')] },
    ],
    draft: '',
    notice: null,
  });
});

it('keeps what was done when the answer breaks off after it', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();

  conversation.send('Make a playlist called Sunday.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: created('Sunday') });
  reply.send({
    type: 'error',
    error: makeApiError('provider_error', 'The Writing AI could not answer.', true).error,
  });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));

  expect(conversation.getState()).toMatchObject({
    messages: [{ role: 'user' }, { role: 'assistant', actions: [created('Sunday')] }],
    draft: '',
    notice: 'The Writing AI could not answer.',
  });
});

it('tells the next request what was done, as part of the answer it was done in', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('Make two playlists.');
  const first = asked[0]!.reply();
  first.send({ type: 'action', action: created('Sunday') });
  first.send({ type: 'text', text: 'Both are there.' });
  first.send({ type: 'action', action: created('Monday') });
  first.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  conversation.send('And one more, called Tuesday.');
  const second = asked[1]!.reply();
  second.send({ type: 'action', action: created('Tuesday') });
  second.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));

  conversation.send('Pin the first one.');

  expect(asked[2]!.request.messages).toEqual([
    { role: 'user', content: 'Make two playlists.' },
    {
      role: 'assistant',
      content: `Both are there.\n\n${createdNote('Sunday')}\n${createdNote('Monday')}`,
    },
    { role: 'user', content: 'And one more, called Tuesday.' },
    { role: 'assistant', content: createdNote('Tuesday') },
    { role: 'user', content: 'Pin the first one.' },
  ]);
  // What is shown stays the model's own words; the receipt is shown from the action.
  expect(conversation.getState().messages[1]!.content).toBe('Both are there.');
});

it('clips a long earlier answer around what was done in it, never the record of it', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('Make a playlist and tell me everything.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: created('Sunday') });
  reply.send({ type: 'text', text: 'x'.repeat(4500) });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));

  conversation.send('And then?');

  const sent = asked[1]!.request.messages[1]!.content;
  expect(sent).toHaveLength(4000);
  expect(sent.endsWith(`x\n\n${createdNote('Sunday')}`)).toBe(true);
});

/** A command the Assistant handed to the player. */
type PlayerAction = Extract<AssistantAction, { status: 'player' }>;
const told = (name: 'continue' | 'pause'): PlayerAction => ({
  status: 'player',
  command: { name },
});

it('records what became of an action, and tells the next request', async () => {
  const asked = captureQuestions();
  const arrived: AssistantAction[] = [];
  const conversation = createAssistantConversation({ onAction: (action) => arrived.push(action) });
  let changes = 0;
  conversation.send('Continue.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: told('continue') });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  conversation.subscribe(() => {
    changes += 1;
  });

  conversation.settleAction(arrived[0] as PlayerAction, 'blocked');

  expect(changes).toBe(1);
  expect(conversation.getState().messages.at(-1)).toEqual({
    role: 'assistant',
    content: '',
    actions: [{ ...told('continue'), outcome: 'blocked' }],
  });

  conversation.send('Did it play?');
  expect(asked[1]!.request.messages[1]).toEqual({
    role: 'assistant',
    content:
      '[Not done by the app: the browser refused to start the audio when the player was told to play on. The user was shown a "Tap to play" button.]',
  });
});

it('settles an action again from where the last outcome left it', async () => {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('Continue.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: told('continue') });
  reply.send({ type: 'action', action: told('pause') });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  const held = () => conversation.getState().messages.at(-1)!.actions!;

  conversation.settleAction(held()[0] as PlayerAction, 'blocked');
  conversation.settleAction(held()[0] as PlayerAction, 'done');

  expect(held()).toEqual([{ ...told('continue'), outcome: 'done' }, told('pause')]);
});

it('leaves the conversation alone when the action settled is no longer in it', async () => {
  const asked = captureQuestions();
  const arrived: AssistantAction[] = [];
  const conversation = createAssistantConversation({ onAction: (action) => arrived.push(action) });
  conversation.send('Continue.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: told('continue') });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  conversation.newChat();
  const before = conversation.getState();

  conversation.settleAction(arrived[0] as PlayerAction, 'done');

  expect(conversation.getState()).toBe(before);
});

it('says a message is going out, inside the call that sends it, and only when one does', () => {
  captureQuestions();
  const onSend = vi.fn();
  const conversation = createAssistantConversation({ onSend });

  conversation.send('   ');
  expect(onSend).not.toHaveBeenCalled();

  conversation.send('Continue.');
  expect(onSend).toHaveBeenCalledOnce();

  // An answer is being written: nothing is sent.
  conversation.send('And next.');
  expect(onSend).toHaveBeenCalledOnce();
});

const SESSION_CARD: AssistantAction = {
  status: 'proposed',
  card: { kind: 'session', prompt: 'calm piano', vocal: 'instrumental' },
};

/** A conversation whose one answer is a card and nothing else. */
async function conversationWithCard() {
  const asked = captureQuestions();
  const conversation = createAssistantConversation();
  conversation.send('Start something calm.');
  const reply = asked[0]!.reply();
  reply.send({ type: 'action', action: SESSION_CARD });
  reply.send({ type: 'done' });
  await vi.waitFor(() => expect(conversation.getState().answering).toBe(false));
  const card = () => conversation.getState().messages[1]!.actions![0] as ProposedChatAction;
  return { asked, conversation, card };
}

it('holds a card without an outcome, and tells the next request that the user left it alone', async () => {
  const { asked, conversation, card } = await conversationWithCard();

  expect(card()).toEqual(SESSION_CARD);

  conversation.send('What is playing?');

  expect(asked[1]!.request.messages[1]!.content).toBe(
    '[Card shown by the app: start a new Session from "calm piano", instrumental. The user has not confirmed it, so it has not happened.]',
  );
});

it('hands back the action as it holds it from then on, and tells the next request what became of a card', async () => {
  const { asked, conversation, card } = await conversationWithCard();

  const settled = conversation.settleAction(card(), 'confirmed');

  expect(settled).toEqual({ ...SESSION_CARD, outcome: 'confirmed' });
  expect(card()).toBe(settled);
  conversation.send('Thanks.');
  expect(asked[1]!.request.messages[1]!.content).toMatch(
    /^\[Card shown by the app: start a new Session .* The user confirmed it, and the app carried it out\.\]$/,
  );
});

it('hands back nothing for an action it no longer holds', async () => {
  const { conversation, card } = await conversationWithCard();
  const offered = card();
  conversation.settleAction(offered, 'confirming');

  // The copy from before is no longer what the conversation holds.
  expect(conversation.settleAction(offered, 'confirmed')).toBeNull();
  expect(card()).toMatchObject({ outcome: 'confirming' });

  const confirming = card();
  conversation.newChat();
  expect(conversation.settleAction(confirming, 'confirmed')).toBeNull();
  expect(conversation.getState().messages).toEqual([]);
});
