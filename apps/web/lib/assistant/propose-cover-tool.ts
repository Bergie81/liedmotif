// `proposeCover`: prepares one new cover for a Session or Playlist of the
// asking user's own, and generates nothing. It asks the app's read-only cover
// gate, the one both regenerate routes ask, so a card is offered only when the
// route would take it. A cover costs money, so the chat gets a card, and only
// the user's click on that card reaches the regenerate route.

import type { LlmTool } from '@liedmotif/providers';
import {
  MAX_COVER_GUIDANCE_LENGTH,
  proposeCoverInputSchema,
  type AssistantCoverCard,
  type ProposeCoverInput,
} from '@liedmotif/shared';
import { coverAttemptGate } from '@/lib/cover-attempt-gate';
import {
  NO_PLAYLIST_PLAYING,
  NO_SESSION_PLAYING,
  NO_SUCH_PLAYLIST,
  NO_SUCH_SESSION,
} from './library-action';
import { quoted } from './music-names';
import { notOffered, proposed } from './proposal';
import { ownPlaylist, ownSession } from './readable-music';
import { PROPOSE_COVER_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';
import type { TurnActions } from './turn-actions';

const GUIDANCE_TOO_LONG = `Art direction has at most ${MAX_COVER_GUIDANCE_LENGTH} characters.`;

const KINDS = {
  session: { label: 'Session', nothingOn: NO_SESSION_PLAYING, noSuch: NO_SUCH_SESSION },
  playlist: { label: 'Playlist', nothingOn: NO_PLAYLIST_PLAYING, noSuch: NO_SUCH_PLAYLIST },
} as const;

/** The asker's own Session or Playlist, by what the app shows as its name; null for every other id. */
async function ownSubject(
  asker: AssistantAsker,
  kind: AssistantCoverCard['subject']['kind'],
  id: string,
): Promise<AssistantCoverCard['subject'] | null> {
  if (kind === 'session') {
    const session = await ownSession(asker, id);
    return session && { kind, id: session.id, name: session.title };
  }
  const playlist = await ownPlaylist(asker, id);
  return playlist && { kind, id: playlist.id, name: playlist.name };
}

export function createProposeCoverTool(
  asker: AssistantAsker,
  actions: TurnActions,
): LlmTool<ProposeCoverInput> {
  const { db, userId, player } = asker;
  return {
    name: PROPOSE_COVER_TOOL_NAME,
    description:
      'Prepares one new cover for one of the user\'s own Sessions or Playlists, with art direction in their words when they gave some, and shows the user a card for it. Leave out the id for the one that is playing now ("this"). Generates nothing and spends nothing: the cover is generated only when the user confirms the card, and it becomes the cover only when they pick it.',
    inputSchema: proposeCoverInputSchema,
    execute: ({ in: kind, id, guidance }) =>
      actions.take('proposed', async () => {
        const words = guidance?.trim() || undefined;
        if (words && words.length > MAX_COVER_GUIDANCE_LENGTH) return notOffered(GUIDANCE_TOO_LONG);
        const { label, nothingOn, noSuch } = KINDS[kind];
        const askedId = id || (player?.source.kind === kind ? player.source.id : undefined);
        if (!askedId) return notOffered(nothingOn);
        const subject = await ownSubject(asker, kind, askedId);
        if (!subject) return notOffered(noSuch);

        const gate = await coverAttemptGate(db, {
          ownerUserId: userId,
          subject: { kind, id: subject.id },
        });
        if (gate.outcome === 'refused') return notOffered(gate.message);
        if (gate.outcome === 'pending') {
          return notOffered(
            `A new cover is already being generated for the ${label} ${quoted(subject.name)}. It will be under Previous covers in its cover dialog.`,
          );
        }
        const card: AssistantCoverCard = {
          kind: 'cover',
          subject,
          ...(words === undefined ? {} : { guidance: words }),
        };
        return proposed(card);
      }),
  };
}
