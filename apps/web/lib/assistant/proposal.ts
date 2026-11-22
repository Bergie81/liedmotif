// What a tool that prepares new spending hands back: the card when the user
// may be offered one, or only words for the model when not. Nothing here, and
// nothing a propose tool calls, creates a Session or buys music: the card is
// data, and the user's confirmation in the browser is the one thing that
// reaches the app's own route.

import { getCoverArtSettings } from '@liedmotif/db';
import {
  targetDurationMinutesSchema,
  type AssistantCard,
  type ProposeSessionInput,
} from '@liedmotif/shared';
import {
  evaluateGenerationBudget,
  headroomRefusalMessage,
  newMusicPausedRefusal,
  newSessionTargetMinutes,
  sessionCreationRefusal,
} from '@/lib/sessions/sessions';
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
 * Why the app would refuse `asker` a new Session right now, paused new music
 * or budget, in the words its own start route answers with; null when it would
 * not. The same gates that route applies, read and never spent.
 */
export async function newSessionRefusal({ db, userId }: AssistantAsker): Promise<string | null> {
  return (await sessionCreationRefusal(db, userId))?.message ?? null;
}

/** How a new Session's propose tool takes its length, as its description tells the model. */
export const NEW_SESSION_LENGTH_RULE =
  "Runs for a length in minutes, or with no limit: give the one the user named, and neither when they named none, which starts the card at the user's Default Session duration. The user can still change the length on the card.";

/** The length the user named for a new Session: minutes, null for No limit, undefined for none. */
export function requestedLength({
  targetDurationMinutes,
  noLimit,
}: Pick<ProposeSessionInput, 'targetDurationMinutes' | 'noLimit'>): number | null | undefined {
  if (targetDurationMinutes != null) return targetDurationMinutes;
  return noLimit ? null : undefined;
}

/**
 * The length a card for a new Session carries: the minutes the user named,
 * null when they asked for No limit, and otherwise their Default Session
 * duration. The user can still move it on the card. Or why no card is
 * offered: a length the start routes refuse, then the app's refusal of a new
 * Session.
 */
export async function newSessionLength(
  asker: AssistantAsker,
  said: Pick<ProposeSessionInput, 'targetDurationMinutes' | 'noLimit'>,
): Promise<{ refusal: string } | { length: { targetDurationMinutes: number | null } }> {
  const requested = requestedLength(said);
  if (requested != null && !targetDurationMinutesSchema.safeParse(requested).success) {
    return { refusal: BAD_DURATION };
  }
  const refusal = await newSessionRefusal(asker);
  if (refusal) return { refusal };
  return {
    length: {
      targetDurationMinutes: await newSessionTargetMinutes(asker.db, asker.userId, requested),
    },
  };
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

/**
 * Why the app would refuse `asker` a Change Vibe right now, in the words the
 * Change Vibe route answers with: paused new music first, then the budget for
 * one more call. Null when neither refuses.
 */
export async function changeVibeRefusal(asker: AssistantAsker): Promise<string | null> {
  return (await newMusicPausedRefusal(asker.db, asker.userId)) ?? generationRefusal(asker);
}

/**
 * The cover choices Home's form starts `asker`'s new Session with when they
 * change none: their Default cover style, left out for Auto, and their
 * Standard covers setting.
 */
export async function homeCoverChoices({
  db,
  userId,
}: AssistantAsker): Promise<
  Pick<Extract<AssistantCard, { kind: 'session' }>, 'coverStyle' | 'useStandardCover'>
> {
  const { defaultStyle, useStandardCoverArt } = await getCoverArtSettings(db, userId);
  return {
    ...(defaultStyle !== 'auto' && { coverStyle: defaultStyle }),
    useStandardCover: useStandardCoverArt,
  };
}

export const NO_ACTIVE_SESSION = 'There is no active Session.';

/** The start route's refusal for a length outside its range. */
export const BAD_DURATION = 'Session duration must be a whole number from 1 to 600 minutes.';
