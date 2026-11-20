'use client';

// A player command as the chat shows it: one quiet line, worded by the app
// from the command itself. When the browser refused to start the audio the
// line carries "Tap to play", so the start happens inside a tap after all.

import { createContext, useContext } from 'react';
import { Check, Play } from 'lucide-react';
import { appPageButtonClass } from './assistant-markdown';
import { playerCommandLine, type PlayerChatAction } from './player-command';

/**
 * Starts the audio for the command whose line was tapped. Null where the chat
 * has no player at hand; the line then only says what happened.
 */
export const TapToPlayContext = createContext<((action: PlayerChatAction) => void) | null>(null);

export function PlayerCommandLine({ action }: { action: PlayerChatAction }) {
  const onTapToPlay = useContext(TapToPlayContext);
  const { text, tapToPlay } = playerCommandLine(action.command, action.outcome);
  return (
    <div className="flex items-center gap-2 text-[13px] leading-[1.45] text-muted">
      {action.outcome === 'done' ? (
        <Check className="h-3.5 w-3.5 flex-none text-lamp" aria-hidden />
      ) : null}
      <span className="min-w-0 break-words">{text}</span>
      {tapToPlay && onTapToPlay ? (
        <button
          type="button"
          onClick={() => onTapToPlay(action)}
          className={`${appPageButtonClass} flex-none`}
        >
          <Play className="h-3 w-3 flex-none fill-current" aria-hidden />
          Tap to Play
        </button>
      ) : null}
    </div>
  );
}
