'use client';

// What the app around the chat lends a card: the budget readout the shell
// already shows, and the app's own flows a confirmed card runs. The flows are
// the ones behind the app's buttons, so a card can do nothing a button cannot.

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AssistantCoverCard,
  ChangeVibeIntentInput,
  CoverCardRegenerateRequest,
  StartSessionRequest,
  StartSurpriseRequest,
} from '@liedmotif/shared';
import type { GenerationHeadroom } from '@/components/app-shell-model';
import { usePlayerContext } from '@/components/player/player-provider';
import { currentPendingStart } from '@/components/player/session-handoff';
import { switchNewMusicOn } from '@/components/player/switch-new-music-on';
import { useHandOffStart } from '@/components/player/use-hand-off-start';
import { useSeedMoreLikeThis } from '@/components/sessions/use-seed-more-like-this';
import {
  getSessionCoverStatus,
  playlistCoverStatus,
  regeneratePlaylistCover,
  regenerateSessionCover,
  selectPlaylistCover,
  selectSessionCover,
  startSession,
  startSurprise,
  type SessionCoverStatusData,
} from '@/lib/api-client';
import { announceOutsideLibraryWrite } from '@/lib/offline/library-writes';
import { useClientId } from '@/lib/use-client-id';

/** What one of the app's flows came to. */
export interface CardFlowResult {
  carriedOut: boolean;
  /** Why not, as the app words it, when the flow has no other place that shows it. */
  refusal?: string;
  /** The cover attempt a cover flow asked for: the one it started, or the one already running. */
  coverGenerationId?: string;
}

/** A flow a click started; null when the click sent nothing and the card may be confirmed again. */
type CardFlow = Promise<CardFlowResult> | null;

/** The Session or Playlist a cover card is for. */
type CoverSubject = Pick<AssistantCoverCard['subject'], 'kind' | 'id'>;

/** What the cover status route tells of a Session's or Playlist's covers, as the cover dialog reads it. */
export type CoverStatus = Pick<
  SessionCoverStatusData,
  'coverImageId' | 'latestRegeneration' | 'history' | 'usage'
>;

export interface CardHost {
  /** What is left of the budget, as the shell's own readout has it; null when nothing counts down. */
  headroom: GenerationHeadroom | null;
  /** Reads that figure again: a card is about to show it. */
  refreshHeadroom: () => void;
  /**
   * Starts a Session the way Home's Start button does, hand-off to the Player
   * included. Null when another Start is still in flight. A refusal shows on
   * the Player.
   */
  startSession: (request: Omit<StartSessionRequest, 'clientId'>) => CardFlow;
  /**
   * Starts a Surprise Me suggestion the way Home's Surprise Me does, hand-off
   * to the Player included. Null when another Start is still in flight. A
   * refusal shows on the Player, and on the card: a suggestion replaced or
   * dismissed elsewhere is not one the Player can name.
   */
  startSurprise: (request: StartSurpriseRequest) => CardFlow;
  /**
   * Changes the vibe through the player's own Change Vibe request. Null when
   * another change is still in flight. A refusal shows where the player shows
   * that request's.
   */
  changeVibe: (sessionId: string, input: ChangeVibeIntentInput) => CardFlow;
  /**
   * Starts More Like This the way the Library's Track menu does, hand-off to
   * the Player included. Null when a Start is still in flight: the app goes to
   * the Player that narrates it.
   */
  moreLikeThis: (seedTrackIds: string[]) => CardFlow;
  /**
   * Saves New music on the way the player's New music sheet does; null minutes
   * is No limit. The player and the mini player follow.
   */
  newMusicOn: (sessionId: string, targetMinutes: number | null) => CardFlow;
  /**
   * Asks for one new cover with the request the cover dialog sends. An
   * attempt already running is answered with, not paid for twice. A refusal
   * shows on the card: the app has no other place that shows it here.
   */
  generateCover: (generate: CoverCardRegenerateRequest) => CardFlow;
  /** Reads the cover status of a Session or Playlist; null when it cannot be read. */
  coverStatus: (subject: CoverSubject, signal: AbortSignal) => Promise<CoverStatus | null>;
  /**
   * Makes a cover from the history the cover with the select request the
   * cover dialog's save sends. It costs nothing. The app's views read their
   * covers again; the player follows on its own status poll, as after the
   * dialog's save.
   */
  selectCover: (subject: CoverSubject, coverImageId: string) => Promise<CardFlowResult>;
}

export function useCardHost(
  headroom: GenerationHeadroom | null,
  /** Re-reads what the shell shows of the budget and of the active Session. */
  refreshChrome: () => void,
): CardHost {
  const handOffStart = useHandOffStart();
  const seedMoreLikeThis = useSeedMoreLikeThis();
  const clientId = useClientId();
  const router = useRouter();
  const { playback, engage, submitChangeVibe } = usePlayerContext();
  // A flow runs long after the render that handed it out, and the seeding
  // hook returns a new function with every render.
  const live = useRef({ playback, seedMoreLikeThis });
  useEffect(() => {
    live.current = { playback, seedMoreLikeThis };
  });
  return useMemo(
    () => ({
      headroom,
      refreshHeadroom: refreshChrome,
      startSession: (request) =>
        handOffStart((signal) => startSession({ ...request, clientId }, signal))?.then(
          (result) => ({ carriedOut: result.ok }),
        ) ?? null,
      startSurprise: (request) =>
        handOffStart((signal) => startSurprise(request, signal))?.then((result) =>
          result.ok ? { carriedOut: true } : { carriedOut: false, refusal: result.error.message },
        ) ?? null,
      changeVibe: (sessionId, input) =>
        submitChangeVibe(sessionId, input, {})?.then((carriedOut) => ({ carriedOut })) ?? null,
      moreLikeThis(seedTrackIds) {
        // The seed flow would ask whether to replace a Start that is still
        // setting up. A card leaves that Start alone, as a Session card does.
        if (currentPendingStart()) {
          router.push('/player');
          return null;
        }
        return live.current
          .seedMoreLikeThis(seedTrackIds)
          .then((failure) =>
            failure === null ? { carriedOut: true } : { carriedOut: false, refusal: failure },
          );
      },
      newMusicOn: (sessionId, targetMinutes) =>
        switchNewMusicOn(sessionId, targetMinutes).then((result) => {
          if (!result.ok) {
            return {
              carriedOut: false,
              refusal: `New music didn’t switch on: ${result.error.message}`,
            };
          }
          const { session } = result.data;
          // The same Session engaged again is its summary refreshed in place.
          if (live.current.playback?.session?.id === session.id) {
            engage(session, { autoplay: false });
          }
          // The shell's own copy of the active Session, which the mini player
          // shows while nothing is engaged.
          refreshChrome();
          return { carriedOut: true };
        }),
      generateCover: (generate) =>
        (generate.kind === 'session'
          ? regenerateSessionCover(generate.request.activitySessionId, {
              ...(generate.request.guidance !== undefined && {
                guidance: generate.request.guidance,
              }),
            })
          : regeneratePlaylistCover(generate.request)
        ).then((result) =>
          result.ok
            ? { carriedOut: true, coverGenerationId: result.data.coverGenerationId }
            : { carriedOut: false, refusal: result.error.message },
        ),
      coverStatus: async (subject, signal) => {
        const status =
          subject.kind === 'session'
            ? await getSessionCoverStatus(subject.id, signal)
            : await playlistCoverStatus(subject.id, signal);
        return status.ok ? status.data : null;
      },
      selectCover: async (subject, coverImageId) => {
        const selected =
          subject.kind === 'session'
            ? await selectSessionCover(subject.id, coverImageId)
            : await selectPlaylistCover(subject.id, coverImageId);
        if (!selected.ok) return { carriedOut: false, refusal: selected.error.message };
        // The cover dialog's callers patch the lists they hold; from the chat
        // those lists, the pages and the shell's copy of the active Session
        // are read again.
        router.refresh();
        announceOutsideLibraryWrite();
        refreshChrome();
        return { carriedOut: true };
      },
    }),
    [headroom, refreshChrome, handOffStart, clientId, router, engage, submitChangeVibe],
  );
}
