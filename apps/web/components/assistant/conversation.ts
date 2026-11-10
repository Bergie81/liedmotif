// The conversation with the Assistant. It lives here, in the tab's memory, and
// nowhere else: the server keeps none of it, so every question carries the
// recent messages along.

import {
  ASSISTANT_MAX_MESSAGE_LENGTH,
  ASSISTANT_MAX_MESSAGES,
  type AssistantAction,
  type AssistantMessage,
  type AssistantPlayerState,
  type AssistantStanding,
} from '@liedmotif/shared';
import { askAssistant } from './ask-assistant';
import { withActionNotes, type ChatAction, type SettleableAction } from './chat-actions';

/** One message as the panel holds it. `content` is what was typed or what the model wrote. */
export interface ConversationMessage extends AssistantMessage {
  /** What the Assistant did while writing this answer, in the order it happened. */
  actions?: readonly ChatAction[];
}

export interface AssistantConversationState {
  /** Oldest first. While an answer is being written, the last one is that answer so far. */
  messages: readonly ConversationMessage[];
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
  /**
   * Records what became of `action`, which must be the action as the
   * conversation holds it now, and returns it as held from here on. One it no
   * longer holds is left alone, and null comes back.
   */
  settleAction<Action extends SettleableAction>(
    action: Action,
    outcome: NonNullable<Action['outcome']>,
  ): Action | null;
}

/**
 * What one request carries: the newest messages, each within the length a
 * message may have. An answer goes back with what was done in it.
 */
function toRequestMessages(messages: readonly ConversationMessage[]): AssistantMessage[] {
  return messages.slice(-ASSISTANT_MAX_MESSAGES).map(({ role, content, actions }) => ({
    role,
    content: withActionNotes(content, actions),
  }));
}

export function createAssistantConversation({
  onStanding,
  onAction,
  onSend,
  getPlayer,
}: {
  /** Told where the user stands with their allowance, each time a response says. */
  onStanding?: (standing: AssistantStanding) => void;
  /** Told what the Assistant did, once, the moment an answer says so. */
  onAction?: (action: AssistantAction) => void;
  /** Told that a message goes out, still inside the call that sent it: a user's gesture, when one did. */
  onSend?: () => void;
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
  // Something done is an answer, with or without words.
  const settle = (notice: string | null) => {
    running = null;
    const [question, answer] = state.messages.slice(-2);
    const unanswered = question && answer && !answer.content.trim() && !answer.actions?.length;
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
      onSend?.();
      const request = new AbortController();
      running = request;
      const asked: ConversationMessage[] = [...state.messages, { role: 'user', content }];
      update({
        messages: [...asked, { role: 'assistant', content: '' }],
        answering: true,
        draft: text === undefined ? '' : state.draft,
        notice: null,
      });
      const extendAnswer = (extend: (answer: ConversationMessage) => ConversationMessage) =>
        update({ messages: [...state.messages.slice(0, -1), extend(state.messages.at(-1)!)] });
      void askAssistant(toRequestMessages(asked), {
        player: getPlayer?.(),
        signal: request.signal,
        onStanding,
        onText: (more) => {
          if (running !== request) return;
          extendAnswer((answer) => ({ ...answer, content: answer.content + more }));
        },
        onAction: (action) => {
          if (running !== request) return;
          extendAnswer((answer) => ({ ...answer, actions: [...(answer.actions ?? []), action] }));
          onAction?.(action);
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
    settleAction(action, outcome) {
      const holds = (message: ConversationMessage) => message.actions?.includes(action);
      if (!state.messages.some(holds)) return null;
      const settled = { ...action, outcome };
      update({
        messages: state.messages.map((message) =>
          holds(message)
            ? {
                ...message,
                actions: message.actions!.map((held) => (held === action ? settled : held)),
              }
            : message,
        ),
      });
      return settled;
    },
  };
}
