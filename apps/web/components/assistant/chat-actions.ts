// What the Assistant did in an answer, as the chat panel holds it. An action
// arrives as a structured event, is shown from that structure, and goes back
// to the model with the next request as a line of the answer it happened in.
// The server keeps no conversation, so that line is the model's only record.

import { ASSISTANT_MAX_MESSAGE_LENGTH, type AssistantAction } from '@liedmotif/shared';
import { cardRecord } from '@/lib/assistant/card-note';
import { receiptNote } from '@/lib/assistant/receipt-note';
import type { ProposedChatAction } from './card';
import { playerCommandRecord, type PlayerChatAction } from './player-command';

/**
 * One action of an answer, with everything the panel knows about what came of
 * it. A receipt is final as it arrives. Every other action carries an
 * `outcome` the browser learns later; without one it is still open.
 */
export type ChatAction =
  Extract<AssistantAction, { status: 'done' }> | PlayerChatAction | ProposedChatAction;

/** An action whose outcome is learned after it arrived. */
export type SettleableAction = Exclude<ChatAction, { status: 'done' }>;

/** What a later turn is told about one action: one line, in brackets, worded by the app. */
export function actionNote(action: ChatAction): string {
  switch (action.status) {
    case 'done':
      return `[Done by the app: ${receiptNote(action.receipt)}]`;
    case 'player':
      return playerCommandRecord(action);
    case 'proposed':
      return cardRecord(action.card, action.outcome);
  }
}

const NOTES_GAP = '\n\n';

/**
 * An answer as a request carries it: what the model wrote, then one line per
 * action. Within the length a message may have, the model's words give way
 * before the record of what was done does.
 */
export function withActionNotes(content: string, actions: readonly ChatAction[] = []): string {
  const notes = actions.map(actionNote).join('\n');
  if (!notes) return content.slice(0, ASSISTANT_MAX_MESSAGE_LENGTH);
  const room = Math.max(0, ASSISTANT_MAX_MESSAGE_LENGTH - notes.length - NOTES_GAP.length);
  const written = content.slice(0, room).trimEnd();
  return (written ? `${written}${NOTES_GAP}${notes}` : notes).slice(
    0,
    ASSISTANT_MAX_MESSAGE_LENGTH,
  );
}
