// What a tool that prepares new spending hands back: the card when the user
// may be offered one, or only words for the model when not. Nothing here, and
// nothing a propose tool calls, creates a Session or buys music: the card is
// data, and the user's confirmation in the browser is the one thing that
// reaches the app's own route.

import type { AssistantCard } from '@liedmotif/shared';
import {
  evaluateGenerationBudget,
  evaluateSessionHeadroom,
  headroomRefusalMessage,
} from '@/lib/sessions';
import { cardCost, cardNote } from './card-note';
import type { AssistantAsker } from './tools';
import type { ActionOutcome } from './turn-actions';

/**
 * The card is offered. The model's line is worded from the card the user is
 * shown, so the two cannot say different things.
 */
export const proposed = (card: AssistantCard): ActionOutcome<'proposed'> => ({
  told: `Prepared: a card to ${cardNote(card)}. Nothing has started and nothing is spent: the app shows the user the card, and only their confirmation there carries it out. Tell the user it is prepared, and that ${cardCost(card)}.`,
  action: { status: 'proposed', card },
});

/** No card is offered, and the model is told why. */
export const notOffered = (why: string): ActionOutcome<'proposed'> => ({
  told: `${why} No card was shown.`,
});

/**
 * Why the app would refuse `asker` a new Session for budget right now, in the
 * words its own start route answers with; null when it would not. The same
 * gate that route applies, read and never spent.
 */
export async function newSessionRefusal({ db, userId }: AssistantAsker): Promise<string | null> {
  const headroom = await evaluateSessionHeadroom(db, userId);
  return headroom.allowed ? null : headroomRefusalMessage(db, headroom);
}

/**
 * Why the app would refuse `asker` even one more music-model call right now,
 * in the words its own routes answer with; null when one fits. The gate the
 * Change Vibe route applies and the worker submits through, read and never
 * spent.
 */
export async function generationRefusal({ db, userId }: AssistantAsker): Promise<string | null> {
  const budget = await evaluateGenerationBudget(db, userId);
  return budget.withinLimits ? null : headroomRefusalMessage(db, budget);
}

export const NO_ACTIVE_SESSION = 'There is no active Session.';

/** The start route's refusal for a length outside its range. */
export const BAD_DURATION = 'Session duration must be a whole number from 1 to 600 minutes.';
