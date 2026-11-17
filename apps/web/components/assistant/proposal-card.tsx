'use client';

// A card in the chat: something that can spend, prepared by the Assistant and
// waiting for the user. It shows what will happen, what is left of the budget
// and one button. The card is worded from its structured values, and the
// button is the only thing on it that acts. A confirmed cover card has one
// more, free one: it makes the cover it generated the cover.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import type { AssistantCoverCard } from '@liedmotif/shared';
import { headroomLine, type GenerationHeadroom } from '@/components/app-shell-model';
import { CoverArt, CoverFallback } from '@/components/player/cover-art';
import { coverUsageLine } from '@/components/player/cover-usage-line';
import { compactPrimaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { OnlineOnly } from '@/components/ui/online-only';
import { cn } from '@/lib/cn';
import { pollWithBackoff } from '@/lib/poll-backoff';
import { cardWording, type CardWording, type ProposedChatAction } from './card';
import type { followCover } from './cover-card';
import type { CardHost } from './use-card-host';

/** The cover dialog's pace for reading the status of an attempt in flight. */
const COVER_POLL_MS = 3000;

export interface Cards {
  /** What is left of the budget, as the app's own readout has it; null when nothing counts down. */
  headroom: GenerationHeadroom | null;
  /** Reads the cover status a cover card shows its budget line from, as the cover dialog reads it. */
  coverStatus: CardHost['coverStatus'];
  /** The user said yes to this card. */
  confirm: (action: ProposedChatAction) => void;
  /** Reads how a confirmed cover card's attempt is going and records it with the card. */
  followCover: (action: ProposedChatAction, signal: AbortSignal) => ReturnType<typeof followCover>;
  /** The user tapped "Use this cover" on a cover card whose cover is ready. */
  applyCover: (action: ProposedChatAction) => void;
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
      ) : outcome === 'confirmed' && action.coverGenerationId ? (
        <CoverAttemptView action={action} wording={wording} />
      ) : (
        <CardStatus ok={outcome === 'confirmed'}>
          {outcome === 'confirmed' ? wording.confirmed : (action.refusal ?? wording.failed)}
        </CardStatus>
      )}
    </div>
  );
}

function CardStatus({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 text-muted">
      {ok ? (
        <Check className="mt-[3px] h-3.5 w-3.5 flex-none text-lamp" aria-hidden />
      ) : (
        <AlertCircle className="mt-[3px] h-3.5 w-3.5 flex-none text-warn" aria-hidden />
      )}
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/**
 * A confirmed cover card's attempt. Its status is read while the card is on
 * screen: once when the card shows, then at the cover dialog's pace for as
 * long as the cover is generating.
 */
function CoverAttemptView({
  action,
  wording,
}: {
  action: ProposedChatAction;
  wording: CardWording;
}) {
  const cards = useContext(CardsContext);
  // A read answers long after the render that sent it, and records what it
  // read with the card as the conversation holds it by then.
  const live = useRef({ action, cards });
  useEffect(() => {
    live.current = { action, cards };
  });
  const attemptId = action.coverGenerationId;
  useEffect(() => {
    const stop = pollWithBackoff(COVER_POLL_MS, async (signal) => {
      const follow = live.current.cards?.followCover;
      if (!follow) return true;
      const read = await follow(live.current.action, signal);
      if (read === 'settled') stop();
      return read !== 'unread';
    });
    return stop;
  }, [attemptId]);

  const { cover } = action;
  if (!cover || cover.state === 'generating') {
    return <CardStatus ok>{wording.confirmed}</CardStatus>;
  }
  if (cover.state === 'failed') {
    return <CardStatus ok={false}>{cover.failure ?? wording.failed}</CardStatus>;
  }
  if (cover.state === 'deleted') {
    return <CardStatus ok={false}>This cover was deleted from Previous covers.</CardStatus>;
  }
  return (
    <>
      <div className="aspect-square w-full max-w-[200px] overflow-hidden rounded-[12px] bg-panel">
        <CoverArt
          coverImageId={cover.coverImageId}
          className="h-full w-full object-cover"
          fallback={<CoverFallback iconClassName="h-10 w-10" />}
        />
      </div>
      {cover.state === 'inUse' ? (
        <CardStatus ok>This cover is in use.</CardStatus>
      ) : (
        <>
          <p className="text-muted">
            The new cover is ready. Your cover stays as it is until you use this one.
          </p>
          <OnlineOnly>
            <button
              type="button"
              disabled={!cards || cover.state === 'using'}
              onClick={() => cards?.applyCover(action)}
              className={cn(compactPrimaryButtonClass, 'mt-1 self-start')}
            >
              {cover.state === 'using' ? <LiedmotifLoader /> : null}
              Use this cover
            </button>
          </OnlineOnly>
          {cover.state === 'ready' && cover.refusal ? (
            <CardStatus ok={false}>{cover.refusal}</CardStatus>
          ) : null}
        </>
      )}
    </>
  );
}

/** The cover budget line the cover dialog shows for the card's Session or Playlist, once it is read. */
function CoverBudget({ subject }: { subject: AssistantCoverCard['subject'] }) {
  const read = useContext(CardsContext)?.coverStatus;
  const [line, setLine] = useState<string | null>(null);
  const { kind, id } = subject;
  useEffect(() => {
    if (!read) return;
    const reading = new AbortController();
    void read({ kind, id }, reading.signal).then((status) => {
      if (!reading.signal.aborted) setLine(status && coverUsageLine(status.usage));
    });
    return () => reading.abort();
  }, [read, kind, id]);
  return line ? ` ${line}.` : null;
}
