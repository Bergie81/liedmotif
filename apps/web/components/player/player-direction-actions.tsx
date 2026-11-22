'use client';

import { ThumbsDown } from 'lucide-react';
import type { ChangeVibeIntentInput, SessionVibe } from '@liedmotif/shared';
import { nowPlayingSpareRowClass } from '@/components/ui/design-system';
import { OnlineOnly } from '@/components/ui/online-only';
import { MoreLikeThisSheet } from '@/components/sessions/more-like-this-sheet';
import { WithTooltip } from '@/components/ui/tooltip';
import type { ChangeVibeOptions } from '@/lib/http/api-client';
import { cn } from '@/lib/cn';
import { ChangeVibeSheet } from './change-vibe-sheet';
import { MoreLikeThisGlyph } from '@/components/ui/glyphs';
import type { PlayerHookAction } from './use-player-session-actions';

/** Dislike as the player says it: the label the listener reads, and
 *  the consequence the one word cannot state. */
const REROLL_LABEL = 'Reroll Track — dislike it for another in the same vibe';

const directionButtonClass =
  'inline-flex min-h-[48px] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-1 rounded-[13px] border border-line-2 bg-[var(--control-bg)] shadow-[var(--shadow-control)] px-2 py-2 text-center text-[13px] font-semibold leading-tight text-paper [transition:transform_.06s_ease,background_.15s_ease] hover:bg-[var(--control-bg-hover)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40';

export function PlayerDirectionActions({
  trackTitle,
  vibe,
  targetDurationMinutes,
  generatedDurationSeconds,
  disabled,
  changeVibeAvailable,
  switchNowLocked = false,
  busyAction,
  changeVibePending,
  changeVibeOpen,
  onChangeVibeOpenChange,
  onReroll,
  onChangeVibe,
  moreLikeThisOpen,
  onMoreLikeThisOpenChange,
  onMoreLikeThis,
}: {
  trackTitle: string | null;
  /** The session's current vibe facets (queue poll) — the overlay preselection. */
  vibe: SessionVibe | null;
  targetDurationMinutes: number | null;
  /** Usable generated music so far — what the duration target counts. */
  generatedDurationSeconds: number;
  /** No current Track: what acts on a Track holds. */
  disabled: boolean;
  /** Change Vibe steers the Session, so it answers to this and not to the Track. */
  changeVibeAvailable: boolean;
  /** A live repeat-one loop blocks new paid jobs, so switch-now cannot deliver
   *  while it holds — the toggle is offered disabled. */
  switchNowLocked?: boolean;
  busyAction: PlayerHookAction | null;
  /** A provider-scoped Change Vibe request is in flight: More Like This holds
   *  until it lands. */
  changeVibePending: boolean;
  /** The Change Vibe sheet's open state — parent-owned, so the options menu
   *  can open the same sheet this bar's trigger does. */
  changeVibeOpen: boolean;
  onChangeVibeOpenChange: (open: boolean) => void;
  /** Dislike: the same prompt is regenerated into a different Track,
   *  and this one goes. It steers nothing — Change Vibe, beside it, is the
   *  action that does. */
  onReroll: () => void;
  /** Fire-and-forget (provider-scoped) — the sheet closes on submit. */
  onChangeVibe: (input: ChangeVibeIntentInput | undefined, options: ChangeVibeOptions) => void;
  /** The More Like This sheet's open state — parent-owned like Change Vibe's. */
  moreLikeThisOpen: boolean;
  onMoreLikeThisOpenChange: (open: boolean) => void;
  /** Start the new Session; true once it started, false on a refusal. */
  onMoreLikeThis: (context: string | undefined) => Promise<boolean>;
}) {
  const anyBusy = busyAction != null || changeVibePending;
  return (
    <div className={cn('mt-8 flex gap-2 desk:mt-12', nowPlayingSpareRowClass)}>
      <OnlineOnly>
        {/* The visible word opens the accessible name, so the two cannot drift
            (WCAG 2.5.3) while the name still carries what "Reroll" leaves out. */}
        <WithTooltip label={REROLL_LABEL}>
          <button
            type="button"
            data-testid="player-reroll"
            aria-label={REROLL_LABEL}
            disabled={disabled}
            onClick={onReroll}
            className={directionButtonClass}
          >
            <ThumbsDown className="h-5 w-5 shrink-0" aria-hidden />
            <span>Reroll Track</span>
          </button>
        </WithTooltip>
        <ChangeVibeSheet
          vibe={vibe}
          targetDurationMinutes={targetDurationMinutes}
          generatedDurationSeconds={generatedDurationSeconds}
          disabled={!changeVibeAvailable}
          switchNowLocked={switchNowLocked}
          triggerClassName={directionButtonClass}
          open={changeVibeOpen}
          onOpenChange={onChangeVibeOpenChange}
          onSubmit={onChangeVibe}
        />
        <MoreLikeThisSheet
          seed={{ kind: 'track', title: trackTitle }}
          open={moreLikeThisOpen}
          onOpenChange={onMoreLikeThisOpenChange}
          onStart={onMoreLikeThis}
          trigger={
            <button type="button" disabled={disabled || anyBusy} className={directionButtonClass}>
              <MoreLikeThisGlyph className="h-6 w-6 shrink-0" />
              <span>More Like This</span>
            </button>
          }
        />
      </OnlineOnly>
    </div>
  );
}
