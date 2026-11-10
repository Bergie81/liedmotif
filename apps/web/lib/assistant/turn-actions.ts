// What one turn may do for the user, and how a tool says what it did. A tool
// that acts runs through here: the turn counts the action, and what it reports
// is the only way an action reaches the reader's stream.

import type { AssistantAction } from '@liedmotif/shared';

type ActionStatus = AssistantAction['status'];

/** How many actions of each kind one user message may lead to. */
export const TURN_ACTION_CAPS: Record<ActionStatus, number> = { done: 3, player: 2, proposed: 1 };

const OVER_CAP: Record<ActionStatus, string> = {
  done: `You have already done ${TURN_ACTION_CAPS.done} things for this message. Nothing was changed. Tell the user what is done, and that they can ask for the rest in their next message.`,
  player: `You have already given the player ${TURN_ACTION_CAPS.player} commands for this message. This one was not passed on. Tell the user what was done, and that they can ask for the rest in their next message.`,
  proposed:
    'You have already prepared a card for this message. No second card was shown. Tell the user what the card they have offers, and that they can ask for the next thing in their next message.',
};

/**
 * What an action tool came to. `told` is what the model reads. `action` is
 * there only when something was done or prepared; without it the action was
 * refused.
 */
export interface ActionOutcome<Status extends ActionStatus = ActionStatus> {
  told: string;
  action?: Extract<AssistantAction, { status: Status }>;
}

export interface TurnActions {
  /**
   * Runs `act` if the turn has an action of this kind left, reports what it
   * did, and returns what the model is told. Over the cap `act` does not run.
   * An action that was refused or threw is not counted.
   */
  take<Status extends ActionStatus>(
    status: Status,
    act: () => Promise<ActionOutcome<Status>>,
  ): Promise<string>;
}

/** The actions of ONE turn; `report` gets each one the moment it is done. */
export function createTurnActions(report: (action: AssistantAction) => void): TurnActions {
  const taken = new Map<ActionStatus, number>();
  const count = (status: ActionStatus, change: number) =>
    taken.set(status, (taken.get(status) ?? 0) + change);
  return {
    async take(status, act) {
      if ((taken.get(status) ?? 0) >= TURN_ACTION_CAPS[status]) return OVER_CAP[status];
      // Counted before it runs: actions the model asks for at once start
      // together, and each has to see the ones before it.
      count(status, 1);
      const outcome = await act().catch((err: unknown) => {
        count(status, -1);
        throw err;
      });
      if (outcome.action) report(outcome.action);
      else count(status, -1);
      return outcome.told;
    },
  };
}
