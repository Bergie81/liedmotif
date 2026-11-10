import type { AssistantAction } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { createTurnActions, type ActionOutcome } from './turn-actions';

const pinned = (name: string): Extract<AssistantAction, { status: 'done' }> => ({
  status: 'done',
  receipt: {
    action: 'pinPlaylist',
    playlist: { id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11', name },
  },
});

/** A turn, and every action it reported in order. */
function openTurn() {
  const reported: AssistantAction[] = [];
  return { reported, actions: createTurnActions((action) => reported.push(action)) };
}

const pin = (name: string) => async (): Promise<ActionOutcome<'done'>> => ({
  told: `Pinned ${name}.`,
  action: pinned(name),
});

describe("one turn's actions", () => {
  it('reports what was done and tells the model the tool’s own words', async () => {
    const { actions, reported } = openTurn();

    expect(await actions.take('done', pin('Running'))).toBe('Pinned Running.');
    expect(reported).toEqual([pinned('Running')]);
  });

  it('reports nothing for an action that was refused', async () => {
    const { actions, reported } = openTurn();

    expect(await actions.take('done', async () => ({ told: 'No Playlist with that id.' }))).toBe(
      'No Playlist with that id.',
    );
    expect(reported).toEqual([]);
  });

  it('does three Library actions for one message and refuses the fourth without running it', async () => {
    const { actions, reported } = openTurn();
    let ran = 0;
    const counted = (name: string) => () => {
      ran += 1;
      return pin(name)();
    };

    for (const name of ['One', 'Two', 'Three']) await actions.take('done', counted(name));
    const fourth = await actions.take('done', counted('Four'));

    expect(fourth).toMatch(/already done 3 things.*nothing was changed/i);
    expect(ran).toBe(3);
    expect(reported).toEqual([pinned('One'), pinned('Two'), pinned('Three')]);
  });

  it('holds the cap when the model asks for all of them at once', async () => {
    const { actions, reported } = openTurn();

    const told = await Promise.all(
      ['One', 'Two', 'Three', 'Four', 'Five'].map((name) => actions.take('done', pin(name))),
    );

    expect(told.filter((line) => /already done 3 things/i.test(line))).toHaveLength(2);
    expect(reported).toHaveLength(3);
  });

  it('does not count an action that was refused or failed', async () => {
    const { actions, reported } = openTurn();

    await actions.take('done', async () => ({ told: 'No Playlist with that id.' }));
    await expect(
      actions.take('done', async () => {
        throw new Error('database is down');
      }),
    ).rejects.toThrow('database is down');
    for (const name of ['One', 'Two', 'Three']) await actions.take('done', pin(name));

    expect(reported).toHaveLength(3);
  });

  it('passes on two player commands for one message, counted apart from the Library actions', async () => {
    const { actions, reported } = openTurn();
    const command =
      (name: 'pause' | 'next' | 'loopOn') => async (): Promise<ActionOutcome<'player'>> => ({
        told: `Told the player: ${name}.`,
        action: { status: 'player', command: { name } },
      });

    for (const name of ['One', 'Two', 'Three']) await actions.take('done', pin(name));
    expect(await actions.take('player', command('next'))).toBe('Told the player: next.');
    expect(await actions.take('player', command('loopOn'))).toBe('Told the player: loopOn.');
    const third = await actions.take('player', command('pause'));

    expect(third).toMatch(/already given the player 2 commands.*not passed on/i);
    expect(reported.slice(3)).toEqual([
      { status: 'player', command: { name: 'next' } },
      { status: 'player', command: { name: 'loopOn' } },
    ]);
  });

  it('counts each turn on its own', async () => {
    const first = openTurn();
    for (const name of ['One', 'Two', 'Three']) await first.actions.take('done', pin(name));
    const second = openTurn();

    expect(await second.actions.take('done', pin('Four'))).toBe('Pinned Four.');
  });
});
