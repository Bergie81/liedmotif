// The conversation with the Assistant. It lives here, in the tab's memory, and
// nowhere else: the server keeps none of it, so every question carries the
// recent messages along.

import {
  ASSISTANT_MAX_MESSAGE_LENGTH,
  ASSISTANT_MAX_MESSAGES,
  type AssistantMessage,
  type AssistantPlayerState,
  type AssistantStanding,
} from '@liedmotif/shared';
import { askAssistant } from './ask-assistant';

export interface AssistantConversationState {
  /** Oldest first. While an answer is being written, the last one is that answer so far. */
  messages: readonly AssistantMessage[];
  answering: boolean;
  /** What is typed and not yet sent. */
  draft: string;
  /** Why the last question got no whole answer. */
  notice: string | null;
}

export interface AssistantConversation {
  getState(): AssistantConversationState;
  subscribe(listener: () => void): () => void;
  setDraft(text: string): void;
  /** Asks `text`, or what is typed when there is none. Does nothing while an answer is being written. */
  send(text?: string): void;
  /** Stops the answer being written. */
  stop(): void;
  newChat(): void;
}

/** What one request carries: the newest messages, each within the length a message may have. */
function toRequestMessages(messages: readonly AssistantMessage[]): AssistantMessage[] {
  return messages.slice(-ASSISTANT_MAX_MESSAGES).map(({ role, content }) => ({
    role,
    content: content.slice(0, ASSISTANT_MAX_MESSAGE_LENGTH),
  }));
}

export function createAssistantConversation({
  onStanding,
  getPlayer,
}: {
  /** Told where the user stands with their allowance, each time a response says. */
  onStanding?: (standing: AssistantStanding) => void;
  /** Asked at every send for what the player has engaged right then. */
  getPlayer?: () => AssistantPlayerState | undefined;
} = {}): AssistantConversation {
  let state: AssistantConversationState = {
    messages: [],
    answering: false,
    draft: '',
    notice: null,
  };
  // The request whose answer is being written. A request that is no longer
  // this one was stopped, and nothing it still delivers reaches the conversation.
  let running: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (change: Partial<AssistantConversationState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };

  // An exchange that brought no answer at all is taken back: the question
  // returns to the field to be sent again, unless something new is typed there.
  const settle = (notice: string | null) => {
    running = null;
    const [question, answer] = state.messages.slice(-2);
    const unanswered = question && answer && !answer.content.trim();
    update({
      answering: false,
      notice,
      ...(unanswered && {
        messages: state.messages.slice(0, -2),
        draft: state.draft || question.content,
      }),
    });
  };

  const stop = () => {
    if (!running) return;
    running.abort();
    settle(null);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraft(text) {
      update({ draft: text });
    },
    send(text) {
      const content = (text ?? state.draft).trim().slice(0, ASSISTANT_MAX_MESSAGE_LENGTH);
      if (!content || running) return;
      const request = new AbortController();
      running = request;
      const asked: AssistantMessage[] = [...state.messages, { role: 'user', content }];
      update({
        messages: [...asked, { role: 'assistant', content: '' }],
        answering: true,
        draft: text === undefined ? '' : state.draft,
        notice: null,
      });
      void askAssistant(toRequestMessages(asked), {
        player: getPlayer?.(),
        signal: request.signal,
        onStanding,
        onText: (more) => {
          if (running !== request) return;
          const answer = state.messages.at(-1)!;
          update({
            messages: [
              ...state.messages.slice(0, -1),
              { ...answer, content: answer.content + more },
            ],
          });
        },
      }).then((outcome) => {
        if (running === request) settle(outcome.ok ? null : outcome.notice);
      });
    },
    stop,
    newChat() {
      // Ended without `stop`, which hands an unanswered question back to the
      // field: a new chat keeps nothing of the old one.
      running?.abort();
      running = null;
      update({ messages: [], answering: false, notice: null });
    },
  };
}
