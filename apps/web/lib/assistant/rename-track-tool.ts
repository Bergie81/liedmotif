// `renameTrack`: gives one of the asking user's own Tracks a Given Name,
// through the function the Rename in the app's Track menus calls. A Track
// shared with them in the Lounge is someone else's, and not theirs to rename.

import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_TRACK_TITLE_LENGTH,
  renameTrackInputSchema,
  renameTrackRequestSchema,
  type RenameTrackInput,
} from '@liedmotif/shared';
import { giveTrackName } from '@/lib/given-names';
import { done, NO_SUCH_TRACK, NO_TRACK_PLAYING, refused } from './library-action';
import { ownTrack } from './readable-music';
import { RENAME_TRACK_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const BAD_NAME = `A Track title has 1 to ${MAX_TRACK_TITLE_LENGTH} characters.`;

export function createRenameTrackTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<RenameTrackInput> {
  const { db, userId, player } = asker;
  return {
    name: RENAME_TRACK_TOOL_NAME,
    description:
      'Gives one of the user\'s own Tracks a new title. Leave out trackId for the Track that is playing now ("this").',
    inputSchema: renameTrackInputSchema,
    execute: (input) =>
      actions.take('done', async () => {
        const parsed = renameTrackRequestSchema.shape.title.safeParse(input.name);
        if (!parsed.success) return refused(BAD_NAME);
        const trackId = input.trackId || player?.trackId;
        if (!trackId) return refused(NO_TRACK_PLAYING);
        const track = await ownTrack(asker, trackId);
        if (!track) return refused(NO_SUCH_TRACK);
        const renamed = await giveTrackName(db, {
          ownerUserId: userId,
          trackId: track.id,
          title: parsed.data,
        });
        if (!renamed) return refused(NO_SUCH_TRACK);
        return done({
          action: 'renameTrack',
          track: { id: renamed.trackId, name: renamed.title },
          previousName: track.title,
        });
      }),
  };
}
