'use client';

// A card in the chat: something that can spend, prepared by the Assistant and
// waiting for the user. It shows what will happen, what is left of the budget
// and one button. The card is worded from its structured values, and the
// button is the only thing on it that acts.

import { createContext, useContext, useEffect, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import type { AssistantCoverCard } from '@liedmotif/shared';
import { headroomLine, type GenerationHeadroom } from '@/components/app-shell-model';
import { coverUsageLine } from '@/components/player/cover-usage-line';
import { compactPrimaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { OnlineOnly } from '@/components/ui/online-only';
import { cn } from '@/lib/cn';
import { cardWording, type ProposedChatAction } from './card';
import type { CardHost } from './use-card-host';

export interface Cards {
  /** What is left of the budget, as the app's own readout has it; null when nothing counts down. */
  headroom: GenerationHeadroom | null;
  /** Reads the cover budget a cover card shows, as the cover dialog reads it. */
  coverUsage: CardHost['coverUsage'];
  /** The user said yes to this card. */
  confirm: (action: ProposedChatAction) => void;
}

/** Without a provider a card can be read and not confirmed. */
export const CardsContext = createContext<Cards | null>(null);

export function ProposalCard({ action }: { action: ProposedChatAction }) {
  const cards = useContext(CardsContext);
  const wording = cardWording(action.card);
  const { outcome } = action;
  const open = !outcome || outcome === 'confirming';
  return (
    <div
      role="group"
      aria-label={wording.title}
      className="flex flex-col gap-2 rounded-[14px] border border-line-2 bg-panel-2 p-3.5 text-[13.5px] leading-[1.45]"
    >
      <p className="font-display text-[15px] font-bold tracking-[-0.01em]">{wording.title}</p>
      {wording.name ? (
        <p className="break-words font-display text-[15px] font-bold text-paper">{wording.name}</p>
      ) : null}
      {wording.words ? <p className="break-words text-paper">“{wording.words}”</p> : null}
      <p className="break-words text-muted">{wording.details}</p>
      {open ? (
        <>
          <p className="text-muted">
            {wording.cost}
            {action.card.kind === 'cover' ? (
              <CoverBudget subject={action.card.subject} />
            ) : cards?.headroom ? (
              ` ${headroomLine(cards.headroom)}.`
            ) : null}
          </p>
          <OnlineOnly>
            <button
              type="button"
              disabled={!cards || outcome === 'confirming'}
              onClick={() => cards?.confirm(action)}
              className={cn(compactPrimaryButtonClass, 'mt-1 self-start')}
            >
              {outcome === 'confirming' ? <LiedmotifLoader /> : null}
              {outcome === 'confirming' ? wording.confirming : wording.confirm}
            </button>
          </OnlineOnly>
        </>
      ) : (
        <p role="status" className="flex items-start gap-2 text-muted">
          {outcome === 'confirmed' ? (
            <Check className="mt-[3px] h-3.5 w-3.5 flex-none text-lamp" aria-hidden />
          ) : (
            <AlertCircle className="mt-[3px] h-3.5 w-3.5 flex-none text-warn" aria-hidden />
          )}
          <span className="min-w-0 break-words">
            {outcome === 'confirmed' ? wording.confirmed : (action.refusal ?? wording.failed)}
          </span>
        </p>
      )}
    </div>
  );
}

/** The cover budget line the cover dialog shows for the card's Session or Playlist, once it is read. */
function CoverBudget({ subject }: { subject: AssistantCoverCard['subject'] }) {
  const read = useContext(CardsContext)?.coverUsage;
  const [line, setLine] = useState<string | null>(null);
  const { kind, id } = subject;
  useEffect(() => {
    if (!read) return;
    const reading = new AbortController();
    void read({ kind, id }, reading.signal).then((usage) => {
      if (!reading.signal.aborted) setLine(usage && coverUsageLine(usage));
    });
    return () => reading.abort();
  }, [read, kind, id]);
  return line ? ` ${line}.` : null;
}
