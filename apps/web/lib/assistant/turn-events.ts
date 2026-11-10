// One turn as its reader gets it: the answer's text and what the tools did,
// each the moment it happens. The text LLM streams text only; a tool reports
// an action from inside a model call, while that stream is silent.

import type { AssistantAction, AssistantStreamEvent } from '@liedmotif/shared';

/** What a turn is made of before it ends. */
export type TurnEvent = Extract<AssistantStreamEvent, { type: 'text' | 'action' }>;

/**
 * Starts a turn and merges what it writes with what it does. `start` gets the
 * function the turn's tools report through and returns the answer's chunks.
 * The answer is pulled only as fast as the events are read. Reading throws
 * what the answer throws, after every event from before the failure. For one
 * reader: `next` is not called again before it has settled.
 */
export function turnEvents(
  start: (report: (action: AssistantAction) => void) => AsyncIterable<string>,
): AsyncIterator<TurnEvent> {
  const ready: TurnEvent[] = [];
  let ended = false;
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const settle = (change: () => void) => {
    change();
    wake?.();
  };

  const chunks = start((action) => settle(() => ready.push({ type: 'action', action })))[
    Symbol.asyncIterator
  ]();
  let pulling = false;
  const pull = () => {
    if (pulling) return;
    pulling = true;
    chunks.next().then(
      (chunk) =>
        settle(() => {
          pulling = false;
          if (chunk.done) ended = true;
          else ready.push({ type: 'text', text: chunk.value });
        }),
      (error: unknown) =>
        settle(() => {
          pulling = false;
          failure = { error };
        }),
    );
  };

  return {
    async next() {
      for (;;) {
        const event = ready.shift();
        if (event) return { done: false, value: event };
        if (failure) throw failure.error;
        if (ended) return { done: true, value: undefined };
        // Listening before the pull: a tool may report while it starts.
        const woken = new Promise<void>((resolve) => {
          wake = resolve;
        });
        pull();
        await woken;
      }
    },
  };
}
