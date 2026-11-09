// The conversation as the model gets it. The browser sends the last few
// messages whole; what reaches the model also has to leave room in a small
// context window for the docs the model reads and for its answer.

import type { AssistantMessage } from '@liedmotif/shared';

/**
 * The conversation's share of one turn, in characters: 4k tokens of a 16k-token
 * context, at 3.5 characters per token.
 */
export const HISTORY_CHAR_BUDGET = 14_000;

/**
 * The newest messages that fit the budget, oldest first. The last message — the
 * one to answer — always stays, and the result opens with a user message: some
 * models' chat templates reject a conversation that starts with the assistant.
 * Expects what the request schema guarantees, a conversation ending with the
 * user.
 */
export function fitHistory(messages: readonly AssistantMessage[]): AssistantMessage[] {
  let start = messages.length - 1;
  let used = messages[start]?.content.length ?? 0;
  while (start > 0 && used + messages[start - 1]!.content.length <= HISTORY_CHAR_BUDGET) {
    start -= 1;
    used += messages[start]!.content.length;
  }
  while (messages[start]?.role === 'assistant') start += 1;
  return messages.slice(start);
}
