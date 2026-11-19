'use client';

// The player as the Assistant's commands reach it from the app shell: the live
// controller, the provider's one Sleep Timer, the player's Stop and the app's
// play flows, each the same function the app's own controls call.

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { primePlayerAutoplay } from '@/components/player/autoplay-arm';
import { usePlayerContext } from '@/components/player/player-provider';
import { stopSession } from '@/lib/http/api-client';
import {
  runPlayerCommand,
  tapToPlay,
  type CommandedPlayer,
  type PlayerCommands,
} from './player-command';
import { assistantPlayerState } from './player-state';
import { usePlayCommand } from './use-play-command';

/**
 * One object for the life of the shell. A command arrives long after the
 * render that handed it out, so everything it touches is read when it runs.
 */
export function usePlayerCommands(shell: {
  /** The page on screen is the Player, which a stopped Session leaves. */
  onPlayerPage: boolean;
  /** Re-reads the shell's own copy of the active Session, which the mini player shows. */
  refreshChrome: () => void;
}): PlayerCommands {
  const context = usePlayerContext();
  const router = useRouter();
  const start = usePlayCommand();
  const live = useRef({ context, router, shell });
  useEffect(() => {
    live.current = { context, router, shell };
  });

  return useMemo(() => {
    const player: CommandedPlayer = {
      controller: () => live.current.context.playback?.player ?? null,
      engaged: () => assistantPlayerState(live.current.context.playback),
      start,
      sleepTimer: {
        start: (minutes) => live.current.context.sleepTimer.start(minutes),
        cancel: () => live.current.context.sleepTimer.cancel(),
      },
      async stopSession() {
        const session = live.current.context.playback?.session;
        if (!session) return false;
        const stopped = await stopSession(session.id);
        if (!stopped.ok) return false;
        const { context, router, shell } = live.current;
        // Music that took over the player while the request was out is not
        // what was stopped: it keeps playing, on the page it plays on.
        const stillEngaged = context.playback?.session?.id === session.id;
        if (stillEngaged) context.release();
        // The stopped Session is no longer the active one the mini player offers.
        shell.refreshChrome();
        if (stillEngaged && shell.onPlayerPage) router.push('/sessions');
        return true;
      },
    };
    // A command acts on what the one before it left in the player, so each
    // waits until the one before has come to its outcome.
    let last: Promise<unknown> = Promise.resolve();
    return {
      prime: primePlayerAutoplay,
      run: (command) => {
        const ran = last.then(() => runPlayerCommand(command, player));
        last = ran.catch(() => undefined);
        return ran;
      },
      tapToPlay: () => tapToPlay(player),
    };
  }, [start]);
}
