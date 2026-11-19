// `newMusicOff`: switches the asking user's active Session to Repeat, the way
// the player's New music control does. Off stops spending, so it runs at once;
// switching New music on can spend and is not a thing this tool does.

import { getActiveSession } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { noToolInputSchema, type NoToolInput } from '@liedmotif/shared';
import { switchSessionMode } from '@/lib/sessions/session-mode';
import { done, refused } from './library-action';
import { named } from './music-names';
import { NEW_MUSIC_OFF_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const NO_ACTIVE_SESSION = 'There is no active Session, so there is no New music to switch off.';

export function createNewMusicOffTool(
  { db, userId }: AssistantAsker,
  actions: TurnActions,
): LlmTool<NoToolInput> {
  return {
    name: NEW_MUSIC_OFF_TOOL_NAME,
    description:
      "Switches New music off for the user's active Session: it stops generating new Tracks and repeats the ones it has.",
    inputSchema: noToolInputSchema,
    execute: () =>
      actions.take('done', async () => {
        const active = await getActiveSession(db, { ownerUserId: userId });
        if (!active) return refused(NO_ACTIVE_SESSION);
        if (active.sessionMode === 'repeat') {
          return refused(
            `New music is already off for the Session ${named(active.title, active.id)}.`,
          );
        }
        const switched = await switchSessionMode(db, {
          ownerUserId: userId,
          sessionId: active.id,
          mode: 'repeat',
        });
        if (!switched) return refused(NO_ACTIVE_SESSION);
        return done({
          action: 'newMusicOff',
          session: { id: active.id, name: active.title },
        });
      }),
  };
}
