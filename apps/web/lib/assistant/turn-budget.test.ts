import type { LlmTool } from '@liedmotif/providers';
import { noToolInputSchema } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { TURN_READ_CHAR_BUDGET, withinTurnBudget } from './turn-budget';

/** A tool that returns `length` characters. */
const returning = (name: string, length: number): LlmTool => ({
  name,
  description: name,
  inputSchema: noToolInputSchema,
  execute: async () => name[0]!.repeat(length),
});

// Two results that each fit the budget, but not together.
const MOST = Math.ceil(TURN_READ_CHAR_BUDGET * 0.6);

describe("one turn's read budget", () => {
  it('counts the results of different tools against the same budget', async () => {
    const [docs, music, small] = withinTurnBudget([
      returning('docs', MOST),
      returning('music', MOST),
      returning('small', 12),
    ]);

    expect(await docs!.execute({})).toHaveLength(MOST);
    const refused = await music!.execute({});
    expect(refused).not.toContain('mmm');
    expect(refused).toMatch(/answer from what you have/i);
    // A result that still fits is still served.
    expect(await small!.execute({})).toBe('ssssssssssss');
  });

  it('serves a result that uses the budget up exactly, and nothing after it', async () => {
    const [all, one] = withinTurnBudget([
      returning('all', TURN_READ_CHAR_BUDGET),
      returning('one', 1),
    ]);

    expect(await all!.execute({})).toHaveLength(TURN_READ_CHAR_BUDGET);
    expect(await one!.execute({})).toMatch(/answer from what you have/i);
  });

  it('starts every turn with a full budget', async () => {
    await withinTurnBudget([returning('docs', MOST)])[0]!.execute({});

    expect(await withinTurnBudget([returning('music', MOST)])[0]!.execute({})).toHaveLength(MOST);
  });

  it('leaves the tools as the model sees them unchanged', () => {
    const tool = returning('docs', 1);

    expect(withinTurnBudget([tool])[0]).toMatchObject({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  });
});
