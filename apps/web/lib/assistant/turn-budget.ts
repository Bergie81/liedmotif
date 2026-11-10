// What one turn may read through its tools. The docs sections and everything
// the tools look up for the asking user draw on the same budget, so a turn
// fits a 16k-token context whatever mix of tools the model calls.

import type { LlmTool } from '@liedmotif/providers';

/**
 * What one turn may read, in characters: the 6k tokens of a 16k-token context
 * that belong to tool results, at 3.5 characters per token. Any single docs
 * section fits; this bounds several results read in a row, or asked for at once.
 */
export const TURN_READ_CHAR_BUDGET = 21_000;

const OVER_BUDGET =
  'That is more than you can still read for this answer. Answer from what you have.';

/**
 * The tools of ONE turn, held to one budget between them: each result counts
 * against it, and a result that would break it is withheld. A tool still runs
 * before its result is measured, so this is for tools that only read.
 */
export function withinTurnBudget(tools: readonly LlmTool[]): LlmTool[] {
  let read = 0;
  return tools.map((tool) => ({
    ...tool,
    async execute(input: unknown) {
      const result = await tool.execute(input);
      if (read + result.length > TURN_READ_CHAR_BUDGET) return OVER_BUDGET;
      read += result.length;
      return result;
    },
  }));
}
