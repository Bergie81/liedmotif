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
  sessionCreationRefusal,
  startingSessionMode,
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
 * Why the app would refuse `asker` a new Session right now, paused new music
 * or budget, in the words its own start route answers with; null when it would
 * not. The same gates that route applies, read and never spent.
 */
export async function newSessionRefusal({ db, userId }: AssistantAsker): Promise<string | null> {
  return (await sessionCreationRefusal(db, userId))?.message ?? null;
}

const HOW_LONG =
  'A new Session keeps generating new Tracks while the user listens, so it needs a length, which is a whole number from 1 to 600 minutes, or no limit. Ask the user how long it should run.';
const NO_LIMIT_ON_REPEAT =
  "This user's new Sessions start with New music off: a new Session generates its first Tracks and then repeats them, so it cannot start with no limit. Offer a length in minutes, or to start it without one and switch New music on afterwards. A length switches New music on for that Session until it reaches the length.";

/**
 * The length a card for a new Session carries, from what the user said: a
 * number of minutes, null for No limit, or left out when the Session starts on
 * Repeat and they named none. Or why no card is offered: a length the start
 * routes refuse, the app's refusal of a new Session, or a length the user
 * still has to choose. Checked in that order.
 */
export async function newSessionLength(
  asker: AssistantAsker,
  {
    targetDurationMinutes,
    noLimit,
  }: Pick<ProposeSessionInput, 'targetDurationMinutes' | 'noLimit'>,
): Promise<{ refusal: string } | { length: { targetDurationMinutes?: number | null } }> {
  if (
    targetDurationMinutes != null &&
    !targetDurationMinutesSchema.safeParse(targetDurationMinutes).success
  ) {
    return { refusal: BAD_DURATION };
  }
  const refusal = await newSessionRefusal(asker);
  if (refusal) return { refusal };
  if (targetDurationMinutes != null) return { length: { targetDurationMinutes } };
  // A Session that starts on Keep Going without a target buys music for as
  // long as it is listened to: that is the user's to say, never a default.
  // One that starts on Repeat stops after its first batch, which is not what
  // "no limit" asks for.
  const keepsGoing = (await startingSessionMode(asker.db, asker.userId)) === 'keep_going';
  if (noLimit) {
    return keepsGoing
      ? { length: { targetDurationMinutes: null } }
      : { refusal: NO_LIMIT_ON_REPEAT };
  }
  return keepsGoing ? { refusal: HOW_LONG } : { length: {} };
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
