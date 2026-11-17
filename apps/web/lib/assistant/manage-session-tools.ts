// `renameSession`, `pinSession`: what the asking user can do to a Session of
// their own from its options menu, through the same functions. There is no
// unpin and no delete here.

import { setSessionPinned } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_SESSION_TITLE_LENGTH,
  pinSessionInputSchema,
  renameSessionInputSchema,
  renameSessionRequestSchema,
  SESSION_PIN_LIMIT_MESSAGE,
  type AssistantPlayerState,
  type PinSessionInput,
  type RenameSessionInput,
} from '@liedmotif/shared';
import { giveSessionName } from '@/lib/given-names';
import { done, NO_SESSION_PLAYING, NO_SUCH_SESSION, refused } from './library-action';
import { ownSession } from './readable-music';
import { PIN_SESSION_TOOL_NAME, RENAME_SESSION_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const BAD_NAME = `A Session name has 1 to ${MAX_SESSION_TITLE_LENGTH} characters.`;

/** The Session a call names, or the one the player has on when it names none: "this". */
const askedSession = (given: string | null | undefined, player: AssistantPlayerState | null) =>
  given || (player?.source.kind === 'session' ? player.source.id : undefined);

export function createRenameSessionTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<RenameSessionInput> {
  const { db, userId, player } = asker;
  return {
    name: RENAME_SESSION_TOOL_NAME,
    description:
      'Gives one of the user\'s own Sessions a new name. Leave out sessionId for the Session that is playing now ("this").',
    inputSchema: renameSessionInputSchema,
    execute: (input) =>
      actions.take('done', async () => {
        const parsed = renameSessionRequestSchema.shape.title.safeParse(input.name);
        if (!parsed.success) return refused(BAD_NAME);
        const sessionId = askedSession(input.sessionId, player);
        if (!sessionId) return refused(NO_SESSION_PLAYING);
        const session = await ownSession(asker, sessionId);
        if (!session) return refused(NO_SUCH_SESSION);
        const renamed = await giveSessionName(db, {
          ownerUserId: userId,
          sessionId: session.id,
          title: parsed.data,
        });
        if (!renamed) return refused(NO_SUCH_SESSION);
        return done({
          action: 'renameSession',
          session: { id: renamed.id, name: renamed.title },
          previousName: session.title,
        });
      }),
  };
}

export function createPinSessionTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<PinSessionInput> {
  const { db, userId, player } = asker;
  return {
    name: PIN_SESSION_TOOL_NAME,
    description:
      'Pins one of the user\'s own Sessions, so it lists first in their Sessions. Leave out sessionId for the Session that is playing now ("this").',
    inputSchema: pinSessionInputSchema,
    execute: (input) =>
      actions.take('done', async () => {
        const sessionId = askedSession(input.sessionId, player);
        if (!sessionId) return refused(NO_SESSION_PLAYING);
        const session = await ownSession(asker, sessionId);
        if (!session) return refused(NO_SUCH_SESSION);
        const result = await setSessionPinned(db, {
          ownerUserId: userId,
          sessionId: session.id,
          pinned: true,
        });
        if (result === 'not_found') return refused(NO_SUCH_SESSION);
        if (result === 'limit_reached') return refused(SESSION_PIN_LIMIT_MESSAGE);
        return done({ action: 'pinSession', session: { id: session.id, name: session.title } });
      }),
  };
}
