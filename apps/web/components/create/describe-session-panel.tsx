'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { MAX_USER_PROMPT_LENGTH } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { cardClass } from '@/components/ui/design-system';
import type { OwnVoiceOffer } from '@/lib/voice/voice';
import {
  FoldSection,
  OwnVoiceToggle,
  OwnVoiceUnavailableHint,
  SegmentedControl,
  SessionLanguageField,
  SkipProfileToggle,
} from './session-start-controls';
import { GenreHintField } from './genre-hint-field';
import { MAX_GENRES } from './genre-vocabulary';
import type { DescribeFineTune } from './create-session-model';
import { useExamplePlaceholder } from './use-example-placeholder';

/** Typography, padding and border shared by the textarea and its invisible
 * sizer — the sizer must wrap exactly like the field so the measured height
 * is the rendered height. */
const promptFieldSharedClasses = 'border px-4 py-3 text-[15px] leading-[1.5]';

/** Safety valve: past it the textarea scrolls instead of the card growing.
 * A native placeholder cannot scroll, so this must stay tall enough that the
 * longest briefing in the pool fits in full on a portrait phone. */
const promptFieldCeilingClass = 'max-h-[60svh]';

export function DescribeSessionPanel({
  prompt,
  onPromptChange,
  llmConfigured,
  skipProfile,
  onSkipProfileChange,
  autoFocus = false,
  action,
}: {
  prompt: string;
  onPromptChange: (value: string) => void;
  /** Whether a text LLM expands the typed words — the input works either way
   * (no LLM means deterministic passthrough); this only gates the info note. */
  llmConfigured: boolean;
  /** Start-without-profile is card-level state; the panel only docks the
   * toggle in its action row. */
  skipProfile: boolean;
  onSkipProfileChange: (checked: boolean) => void;
  /** Focus the field on mount (a prefilled hand-off lands ready to review). */
  autoFocus?: boolean;
  /** Another way to fill the card than typing, docked before the profile toggle. */
  action?: ReactNode;
}) {
  const { placeholder, example, settle } = useExamplePlaceholder(prompt);

  return (
    <div className={cn(cardClass, 'relative')}>
      <label htmlFor="vibe-prompt" className="sr-only">
        Describe the music you want
      </label>
      {/* The sizer and the textarea share one grid cell, so the cell — and the
       * stretched textarea — is always as tall as the full example (or the
       * user's own text), before the first frame is typed. Height never moves
       * mid-animation, and a long user prompt auto-grows the same way. */}
      <div className="grid">
        <div
          aria-hidden
          className={cn(
            'invisible whitespace-pre-wrap break-words [grid-area:1/1]',
            promptFieldSharedClasses,
            promptFieldCeilingClass,
          )}
        >
          {/* Trailing space: text ending in a newline would otherwise collapse
           * its final, empty line and the field would be one row short. */}
          {(prompt || example) + ' '}
        </div>
        <textarea
          id="vibe-prompt"
          data-testid="vibe-prompt"
          rows={3}
          maxLength={MAX_USER_PROMPT_LENGTH}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onFocus={settle}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className={cn(
            'w-full resize-none rounded-xl border-line-2 bg-[var(--field-bg)] shadow-[var(--shadow-field)] light:focus:bg-panel text-paper [grid-area:1/1] placeholder:text-dim focus:border-lamp/60 focus:shadow-[0_0_0_3px_var(--lamp-glow)]',
            promptFieldSharedClasses,
            promptFieldCeilingClass,
          )}
        />
      </div>
      <div className="mt-3 flex items-center gap-6">
        {action}
        <SkipProfileToggle
          checked={skipProfile}
          onCheckedChange={onSkipProfileChange}
          className="min-w-0 flex-1"
        />
      </div>

      {!llmConfigured ? (
        <div className="mt-4 flex items-start gap-2 rounded-card-sm border border-line-2 bg-paper/[0.03] px-4 py-3 text-[13.5px]">
          <Info className="mt-px h-[17px] w-[17px] shrink-0 text-dim" aria-hidden />
          <p className="text-muted">
            <strong className="font-semibold text-paper">No Text AI connected.</strong> Your words
            go to the music model exactly as written; your picks still apply.
          </p>
          <Link
            href="/settings/llm"
            className="ml-auto self-center whitespace-nowrap font-semibold text-lamp"
          >
            Add key
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** The "Fine-tune" fold — rendered inside the shared extras stack (one card:
 * Fine-tune → Cover art → Guardrails, per the draft home). Every pick rides
 * the request, so the caller owns the state (it must survive to submit). */
export function DescribeFineTuneSection({
  picks,
  onPicksChange,
  ownVoiceOffer,
  forYouGenres,
  className,
  children,
}: {
  picks: DescribeFineTune;
  onPicksChange: (patch: Partial<DescribeFineTune>) => void;
  /** How Own Voice is presented: `setup` disables the toggle with the hint;
   * `hidden` renders neither (the shared controls own that branch). */
  ownVoiceOffer: OwnVoiceOffer;
  forYouGenres: readonly string[];
  className?: string;
  /** Extra controls placed above the genre picks. */
  children?: ReactNode;
}) {
  // Own Voice is vocal by definition but in the saved voice, so the gender
  // preference stays out of the question and its seg is dropped.
  const showVoice = picks.vocal === 'vocal' && !picks.ownVoice;

  return (
    <FoldSection title="Fine-tune" embedded className={className}>
      <p className="mb-4 text-[11.5px] leading-[1.5] text-dim">
        No need to repeat these picks in your words.
      </p>
      {children ? <div className="mb-6">{children}</div> : null}
      <div className="mb-6">
        <GenreHintField
          selected={picks.genres}
          onChange={(genres) => onPicksChange({ genres })}
          hint={`PICK UP TO ${MAX_GENRES} GENRES`}
          forYouGenres={forYouGenres}
        />
      </div>
      <div className="mb-6">
        <SegmentedControl
          label="Energy"
          value={picks.energy}
          onChange={(energy) => onPicksChange({ energy })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]}
        />
      </div>
      <div className="mb-6">
        <SegmentedControl
          label="Vocals"
          value={picks.vocal}
          onChange={(vocal) => onPicksChange({ vocal })}
          disabled={picks.ownVoice}
          beside={
            <OwnVoiceToggle
              ownVoice={picks.ownVoice}
              onOwnVoiceChange={(ownVoice) => onPicksChange({ ownVoice })}
              offer={ownVoiceOffer}
            />
          }
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'instrumental', label: 'Instrumental' },
            { value: 'vocal', label: 'Vocals' },
          ]}
        />
        <OwnVoiceUnavailableHint offer={ownVoiceOffer} />
      </div>
      {/* Voice docks in directly under Vocals so they read as one topic. */}
      {showVoice ? (
        <div className="mb-6">
          <SegmentedControl
            label="Voice"
            value={picks.voice}
            onChange={(voice) => onPicksChange({ voice })}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'female', label: 'Female' },
              { value: 'male', label: 'Male' },
            ]}
          />
        </div>
      ) : null}
      <SessionLanguageField
        value={picks.language}
        onChange={(language) => onPicksChange({ language })}
      />
    </FoldSection>
  );
}
