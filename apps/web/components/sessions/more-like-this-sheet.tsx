'use client';

import { useState, type ReactNode } from 'react';
import { MAX_USER_PROMPT_LENGTH, type MoreLikeThisRequest } from '@liedmotif/shared';
import { useAppChrome } from '@/components/app-chrome-context';
import { SessionLanguageSelect } from '@/components/session-language-select';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import type { SessionLanguageChoice } from '@/lib/sessions/session-languages';
import { formatTrackCount } from './session-list-model';

/** What a More Like This is seeded from, as the sheet names it. */
export type MoreLikeThisSeed =
  | { kind: 'track'; title: string | null }
  /** `trackCount` is how many of the Playlist's Tracks seed it, not its size. */
  | { kind: 'playlist'; name: string; trackCount: number };

/** What the sheet adds to the More Like This request. */
export type MoreLikeThisAsk = Pick<MoreLikeThisRequest, 'context' | 'language'>;

/** The request's additions: a blank field sends no context and Auto Detect no
 *  language, so with both More Like This runs exactly as it does without the
 *  sheet. Without a text LLM nothing is sent, as nothing could read it. */
function askFrom(
  llmConfigured: boolean,
  text: string,
  language: SessionLanguageChoice,
): MoreLikeThisAsk {
  if (!llmConfigured) return {};
  const context = text.trim().slice(0, MAX_USER_PROMPT_LENGTH).trim();
  return {
    ...(context ? { context } : {}),
    ...(language !== 'auto' ? { language } : {}),
  };
}

/**
 * The one More Like This sheet, opened from every surface that offers it.
 * `onStart` runs inside the Start New Session tap, so the surface's seeding
 * keeps the browser's autoplay gesture; it resolves true once the new Session
 * started and false on a refusal, which leaves the sheet open with the words.
 */
export function MoreLikeThisSheet({
  seed,
  open,
  onOpenChange,
  onStart,
  trigger,
}: {
  seed: MoreLikeThisSeed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (ask: MoreLikeThisAsk) => Promise<boolean>;
  /** A button that opens the sheet itself, for a surface that has one. */
  trigger?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent side="bottom" className="flex flex-col">
        <MoreLikeThisForm seed={seed} onStarted={() => onOpenChange(false)} onStart={onStart} />
      </SheetContent>
    </Sheet>
  );
}

function MoreLikeThisForm({
  seed,
  onStart,
  onStarted,
}: {
  seed: MoreLikeThisSeed;
  onStart: (ask: MoreLikeThisAsk) => Promise<boolean>;
  onStarted: () => void;
}) {
  const { llmConfigured } = useAppChrome();
  const [text, setText] = useState('');
  const [language, setLanguage] = useState<SessionLanguageChoice>('auto');
  const [busy, setBusy] = useState(false);

  async function start() {
    if (busy) return;
    setBusy(true);
    const started = await onStart(askFrom(llmConfigured, text, language));
    setBusy(false);
    if (started) onStarted();
  }

  return (
    <>
      <SheetHeader
        title="More Like This"
        description="Start a new session in this style. The current session keeps playing until the new one is ready to take over."
        closeDisabled={busy}
      />
      <SheetBody>
        <div className="mt-5 rounded-card-sm border border-line bg-[var(--control-bg)] p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
            {seed.kind === 'track' ? 'Seed Track' : 'Seed Tracks'}
          </div>
          <div className="mt-1 truncate font-display text-[17px] font-bold">
            {seed.kind === 'track'
              ? (seed.title ?? 'Untitled Track')
              : `${formatTrackCount(seed.trackCount)} from ${seed.name}`}
          </div>
        </div>
        {llmConfigured ? (
          <>
            <label
              htmlFor="more-like-this-context"
              className="mt-4 block text-[13px] font-semibold"
            >
              What is it for? <span className="font-normal text-dim">(optional)</span>
            </label>
            <textarea
              id="more-like-this-context"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="For cooking, about autumn in Berlin…"
              maxLength={MAX_USER_PROMPT_LENGTH}
              className={cn(inputClass, 'mt-2 min-h-[72px] w-full resize-y')}
            />
            <p className="mt-2 text-[12.5px] text-dim">
              Changes the names, lyrics and cover, never the style.
            </p>
            <div className="mt-4 text-[13px] font-semibold">Language</div>
            <SessionLanguageSelect
              value={language}
              onChange={setLanguage}
              ariaLabel="Language"
              testId="more-like-this-language"
              triggerClassName="mt-2 w-full"
            />
            <p className="mt-2 text-[12.5px] text-dim">
              Auto Detect uses the language you write in. Vocals are sung in it too.
            </p>
          </>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void start()}
          className={cn(primaryButtonClass, 'mt-4 w-full')}
        >
          {busy ? 'Starting Session…' : 'Start New Session'}
        </button>
        <SheetClose disabled={busy} className={cn(secondaryButtonClass, 'mt-2 w-full')}>
          Cancel
        </SheetClose>
      </SheetBody>
    </>
  );
}
