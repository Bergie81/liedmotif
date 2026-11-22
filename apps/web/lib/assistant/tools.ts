// The tools of one Assistant turn, and who they work for. A tool that reads
// or changes the asking user's own data is created with that user: it calls
// the app's own domain functions with their id, so it finds what they find in
// the app and can do what they can do there, no more and no less.

import type { Database, UserRole } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { createLogger, type AssistantPlayerState } from '@liedmotif/shared';
import { createAddToPlaylistTool } from './add-to-playlist-tool';
import { createBudgetTool } from './budget-tool';
import { createChangeSettingTool } from './change-setting-tool';
import { loadDocs, type DocsPage } from './docs';
import { createFavoriteTrackTool } from './favorite-track-tool';
import { createFindMusicTool } from './find-music-tool';
import { createListTracksTool } from './list-tracks-tool';
import {
  createCreatePlaylistTool,
  createPinPlaylistTool,
  createRenamePlaylistTool,
} from './manage-playlist-tools';
import { createPinSessionTool, createRenameSessionTool } from './manage-session-tools';
import { createNewMusicOffTool } from './new-music-off-tool';
import { createNowPlayingTool } from './now-playing-tool';
import { createPlayTool } from './play-tool';
import { createPlayerControlTool, createSleepTimerTool } from './player-tools';
import { createProposeChangeVibeTool } from './propose-change-vibe-tool';
import { createProposeCoverTool } from './propose-cover-tool';
import { createProposeMoreLikeThisTool } from './propose-more-like-this-tool';
import { createProposeNewMusicOnTool } from './propose-new-music-on-tool';
import { createProposeSessionTool } from './propose-session-tool';
import { createProposeSurpriseTool } from './propose-surprise-tool';
import { createReadDocsTool } from './read-docs-tool';
import { createReadTrackTool } from './read-track-tool';
import { createRenameTrackTool } from './rename-track-tool';
import type { TurnActions } from './turn-actions';
import { withinTurnBudget } from './turn-budget';

const logger = createLogger({ name: 'assistant' });

/** Who a turn's tools act for. The id and the role are the server's own reading, never the request's. */
export interface AssistantAsker {
  db: Database;
  userId: string;
  role: UserRole;
  /**
   * What the browser's player has engaged, as the request reported it; null
   * when nothing is. Ids a browser sent: a tool looks them up as `userId`.
   */
  player: AssistantPlayerState | null;
  /** Aborts once the reader stops the answer; an action still under way then keeps nothing. */
  signal?: AbortSignal;
}

const LOOKUP_FAILED = 'That could not be looked up right now. Answer from what you have.';
const ACTION_FAILED = 'That could not be done right now. Tell the user it did not work.';

/**
 * A tool that fails tells the model so and nothing more. What a tool returns
 * goes to the text-LLM provider, and an error's own text may quote a query.
 * The log gets the tool and the kind of error, never the input.
 */
const failingQuietly =
  (told: string) =>
  (tool: LlmTool): LlmTool => ({
    ...tool,
    async execute(input: unknown) {
      try {
        return await tool.execute(input);
      } catch (err) {
        logger.error('Assistant tool failed', {
          tool: tool.name,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        return told;
      }
    },
  });

/**
 * The tools for ONE turn of `asker`. The ones that read share one turn's read
 * budget. The ones that act report through `actions`, which also caps them;
 * they stand outside the read budget, because that budget withholds a result
 * after the tool ran, and what an action did must always reach the model.
 */
export function createAssistantTools(
  asker: AssistantAsker,
  actions: TurnActions,
  pages: readonly DocsPage[] = loadDocs(),
): LlmTool[] {
  return [
    ...withinTurnBudget(
      [
        createReadDocsTool(pages),
        createNowPlayingTool(asker),
        createBudgetTool(asker),
        createFindMusicTool(asker),
        createListTracksTool(asker),
        createReadTrackTool(asker),
      ].map(failingQuietly(LOOKUP_FAILED)),
    ),
    ...[
      createFavoriteTrackTool(asker, actions),
      createAddToPlaylistTool(asker, actions),
      createCreatePlaylistTool(asker, actions),
      createRenamePlaylistTool(asker, actions),
      createPinPlaylistTool(asker, actions),
      createRenameSessionTool(asker, actions),
      createPinSessionTool(asker, actions),
      createRenameTrackTool(asker, actions),
      createNewMusicOffTool(asker, actions),
      createChangeSettingTool(asker, actions),
      createPlayTool(asker, actions),
      createPlayerControlTool(asker, actions),
      createSleepTimerTool(asker, actions),
      createProposeSessionTool(asker, actions),
      createProposeChangeVibeTool(asker, actions),
      createProposeMoreLikeThisTool(asker, actions),
      createProposeNewMusicOnTool(asker, actions),
      createProposeSurpriseTool(asker, actions),
      createProposeCoverTool(asker, actions),
    ].map(failingQuietly(ACTION_FAILED)),
  ];
}
