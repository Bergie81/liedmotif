import type { AssistantAction } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { turnEvents, type TurnEvent } from './turn-events';

const PINNED: AssistantAction = {
  status: 'done',
  receipt: {
    action: 'pinPlaylist',
    playlist: { id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11', name: 'Running' },
  },
};

const text = (chunk: string): TurnEvent => ({ type: 'text', text: chunk });
const action: TurnEvent = { type: 'action', action: PINNED };

/** Every event of a turn, and the error that ended it when one did. */
async function read(events: AsyncIterator<TurnEvent>) {
  const seen: TurnEvent[] = [];
  try {
    for (let next = await events.next(); !next.done; next = await events.next()) {
      seen.push(next.value);
    }
  } catch (error) {
    return { seen, error };
  }
  return { seen, error: null };
}

/** A promise the test settles by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("one turn's events", () => {
  it('carry the answer in the order it is written', async () => {
    const events = turnEvents(async function* () {
      yield 'Open ';
      yield 'Members.';
    });

    expect(await read(events)).toEqual({ seen: [text('Open '), text('Members.')], error: null });
  });

  it('carry an action between the text it happened between', async () => {
    const events = turnEvents(async function* (report) {
      yield 'One moment.';
      report(PINNED);
      yield 'Done.';
    });

    expect((await read(events)).seen).toEqual([text('One moment.'), action, text('Done.')]);
  });

  it('hand an action on while the model is still silent', async () => {
    const answer = gate();
    const events = turnEvents(async function* (report) {
      report(PINNED);
      await answer.opened;
      yield 'Done.';
    });

    expect(await events.next()).toEqual({ done: false, value: action });
    answer.open();
    expect(await events.next()).toEqual({ done: false, value: text('Done.') });
    expect((await events.next()).done).toBe(true);
  });

  it('are an answer when the model acts and writes nothing', async () => {
    // eslint-disable-next-line require-yield
    const events = turnEvents(async function* (report) {
      report(PINNED);
    });

    expect(await read(events)).toEqual({ seen: [action], error: null });
  });

  it('end at once when the model neither writes nor acts', async () => {
    const events = turnEvents(async function* () {});

    expect((await events.next()).done).toBe(true);
  });

  it('deliver what happened before a failure, then the failure', async () => {
    const failure = new Error('provider dropped');
    const events = turnEvents(async function* (report) {
      report(PINNED);
      yield 'One';
      throw failure;
    });

    expect(await read(events)).toEqual({ seen: [action, text('One')], error: failure });
  });
});
