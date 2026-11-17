// A confirmed cover card after the click: it follows its attempt through the
// cover status route, and once the cover is ready one more tap makes it the
// cover. A generated cover is never applied on its own, as in the cover
// dialog: a card left alone changes nothing, and the cover stays in the history.

import type { CoverAttempt, ProposedChatAction } from './card';
import type { AssistantConversation } from './conversation';
import type { CardHost, CoverStatus } from './use-card-host';

export interface CoverCardFollowing {
  /** The conversation the card is part of. */
  conversation: Pick<AssistantConversation, 'settleAction'>;
  host: Pick<CardHost, 'coverStatus' | 'selectCover'>;
}

/**
 * What `status` tells of the attempt `attemptId`, knowing what an earlier read
 * of it told (`held`). Null when it tells nothing: a later attempt is the
 * latest, and no read ever saw this one.
 */
export function coverAttemptFrom(
  status: CoverStatus,
  attemptId: string,
  held: CoverAttempt | undefined,
): CoverAttempt | null {
  const latest = status.latestRegeneration;
  if (latest?.coverGenerationId === attemptId) {
    if (latest.status === 'failed') return { state: 'failed', failure: latest.failureMessageSafe };
    if (latest.status === 'generating') {
      return { state: 'generating', coverImageId: latest.coverImageId };
    }
    return generatedCover(status, latest.coverImageId);
  }
  if (!held || held.state === 'failed') return held ?? null;
  return generatedCover(status, held.coverImageId);
}

/** Where a generated cover is now: the cover, still in the history, or deleted from it. */
function generatedCover(status: CoverStatus, coverImageId: string): CoverAttempt {
  if (status.coverImageId === coverImageId) return { state: 'inUse', coverImageId };
  if (status.history.some((entry) => entry.coverImageId === coverImageId)) {
    return { state: 'ready', coverImageId };
  }
  return { state: 'deleted', coverImageId };
}

const sameAttempt = (a: CoverAttempt | undefined, b: CoverAttempt) =>
  a?.state === b.state &&
  ('coverImageId' in a ? a.coverImageId : null) === ('coverImageId' in b ? b.coverImageId : null);

/**
 * Reads how the attempt of `action`, a confirmed cover card, is going, and
 * records it with the card. `generating` asks for another read later,
 * `unread` is a read that failed, and `settled` needs no other read.
 */
export async function followCover(
  action: ProposedChatAction,
  { conversation, host }: CoverCardFollowing,
  signal: AbortSignal,
): Promise<'generating' | 'settled' | 'unread'> {
  const { card, coverGenerationId, cover } = action;
  if (card.kind !== 'cover' || !coverGenerationId) return 'settled';
  const status = await host.coverStatus(card.subject, signal);
  if (!status) return 'unread';
  const read = coverAttemptFrom(status, coverGenerationId, cover);
  if (!read) return 'settled';
  // A tap on "Use this cover" still on its way is what the card shows until it answers.
  if (cover?.state !== 'using' && !sameAttempt(cover, read)) {
    conversation.settleAction(action, 'confirmed', { cover: read });
  }
  return read.state === 'generating' ? 'generating' : 'settled';
}

/**
 * Makes the ready cover of `action` the cover, with the cover dialog's select
 * request. Sent once: the tap records that it was sent before the request
 * goes, and a card already past `ready` is left alone.
 */
export function applyCover(action: ProposedChatAction, { conversation, host }: CoverCardFollowing) {
  const { card, cover } = action;
  if (card.kind !== 'cover' || cover?.state !== 'ready') return;
  const { coverImageId } = cover;
  const using = conversation.settleAction(action, 'confirmed', {
    cover: { state: 'using', coverImageId },
  });
  if (!using) return;
  void host.selectCover(card.subject, coverImageId).then(({ carriedOut, refusal }) => {
    conversation.settleAction(using, 'confirmed', {
      cover: carriedOut
        ? { state: 'inUse', coverImageId }
        : { state: 'ready', coverImageId, ...(refusal !== undefined && { refusal }) },
    });
  });
}
