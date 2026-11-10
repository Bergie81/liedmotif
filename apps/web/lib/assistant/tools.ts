// The tools of one Assistant turn, and who they work for. A tool that reads
// the asking user's own data is created with that user: it calls the app's own
// domain functions with their id, so it finds what they find in the app, no
// more and no less.

import type { Database, UserRole } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { createLogger, type AssistantPlayerState } from '@liedmotif/shared';
import { createBudgetTool } from './budget-tool';
import { loadDocs, type DocsPage } from './docs';
import { createFindMusicTool } from './find-music-tool';
import { createListTracksTool } from './list-tracks-tool';
import { createNowPlayingTool } from './now-playing-tool';
import { createReadDocsTool } from './read-docs-tool';
import { withinTurnBudget } from './turn-budget';

const logger = createLogger({ name: 'assistant' });

/** Who a turn's tools act for. Every field comes from the server's own reading of the request. */
export interface AssistantAsker {
  db: Database;
  userId: string;
  role: UserRole;
  /** What the browser's player has engaged, as the request reported it; null when nothing is. */
  player: AssistantPlayerState | null;
}

const LOOKUP_FAILED = 'That could not be looked up right now. Answer from what you have.';

/**
 * A lookup that fails tells the model so and nothing more. What a tool returns
 * goes to the text-LLM provider, and an error's own text may quote a query.
 * The log gets the tool and the kind of error, never the input.
 */
function failingQuietly(tool: LlmTool): LlmTool {
  return {
    ...tool,
    async execute(input: unknown) {
      try {
        return await tool.execute(input);
      } catch (err) {
        logger.error('Assistant tool failed', {
          tool: tool.name,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        return LOOKUP_FAILED;
      }
    },
  };
}

/** The tools for ONE turn of `asker`; together they read within one turn's budget. */
export function createAssistantTools(
  asker: AssistantAsker,
  pages: readonly DocsPage[] = loadDocs(),
): LlmTool[] {
  return withinTurnBudget(
    [
      createReadDocsTool(pages),
      createNowPlayingTool(asker),
      createBudgetTool(asker),
      createFindMusicTool(asker),
      createListTracksTool(asker),
    ].map(failingQuietly),
  );
}
