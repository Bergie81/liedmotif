'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { CoverStyleChoice } from '@liedmotif/shared';
import { COVER_STYLE_CHOICES, MAX_SESSION_AVOID_LENGTH } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import type { OwnVoiceOffer } from '@/lib/voice/voice';
import type { SessionLanguageChoice } from '@/lib/sessions/session-languages';
import { CoverStyleSelect } from '@/components/covers/cover-style-select';
import { SessionLanguageSelect } from '@/components/session-language-select';
import { Switch } from '@/components/ui/controls';
import { Slider } from '@/components/ui/slider';
import {
  cardClass,
  segmentedListClass,
  segmentedTriggerClass,
} from '@/components/ui/design-system';
import { inputClass } from '@/components/ui/form-styles';
import type { GuardrailDraft } from './create-session-model';

export function FoldSection({
  title,
  children,
  defaultOpen = false,
  embedded = false,
  className,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  embedded?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={cn(!embedded && cardClass, 'group/fold p-0', className)}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [-webkit-tap-highlight-color:transparent] [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted">
          {title}
        </span>
        <ChevronDown className="ml-auto h-[17px] w-[17px] shrink-0 text-dim transition-transform duration-150 ease-[ease] group-open/fold:rotate-180" />
      </summary>
      <div className="px-4 pb-4">{children}</div>
    </details>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  beside,
}: {
  label: string;
  /** Null renders with no selection (a facet the current state doesn't carry). */
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
  /** Disable the whole seg while another control owns its question — it keeps
   * (and shows, dimmed) its last answer, so releasing that control restores
   * exactly the state you left. */
  disabled?: boolean;
  /** A companion control rendered beside the seg in one wrapping row (the
   * draft's seg-row) — e.g. the Own Voice toggle beside Vocals. */
  beside?: ReactNode;
}) {
  const seg = (
    <div
      className={cn(
        segmentedListClass,
        beside != null && 'min-w-0 flex-[1_1_200px]',
        disabled && 'opacity-35',
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          data-state={value === option.value ? 'active' : 'inactive'}
          className={segmentedTriggerClass}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  return (
    <fieldset>
      <legend className="mb-2 flex w-full items-baseline justify-between text-[15px] font-semibold text-paper">
        {label}
        {hint ? (
          <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
            {hint}
          </span>
        ) : null}
      </legend>
      {beside != null ? (
        <div className="flex flex-wrap gap-2">
          {seg}
          {beside}
        </div>
      ) : (
        seg
      )}
    </fieldset>
  );
}

/** The Language select in the fine-tune fold. Unlike Voice it is NOT
 * vocal-gated, because the language also steers title language for
 * instrumental Sessions. */
export function SessionLanguageField({
  value,
  onChange,
}: {
  value: SessionLanguageChoice;
  onChange: (value: SessionLanguageChoice) => void;
}) {
  return (
    <label className="flex flex-col gap-2 text-[15px] font-semibold text-paper">
      <span className="flex items-baseline justify-between">
        Language
        <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
          TITLES &amp; VOCALS
        </span>
      </span>
      <SessionLanguageSelect
        value={value}
        onChange={onChange}
        ariaLabel="Language"
        testId="session-language"
        triggerClassName="w-full"
      />
    </label>
  );
}

/** The "Use my voice" opt-in beside the Vocals control. `ready` is enabled;
 * `setup` is disabled (with the hint below) until a
 * ready voice profile exists AND the music provider can sing with it; `hidden`
 * renders nothing — a viewer who can never hold the capability gets no control
 * at all. The hidden branch lives here (and in the hint) so a call site cannot
 * render half a hidden control. */
export function OwnVoiceToggle({
  ownVoice,
  onOwnVoiceChange,
  offer,
}: {
  ownVoice: boolean;
  onOwnVoiceChange: (value: boolean) => void;
  offer: OwnVoiceOffer;
}) {
  if (offer === 'hidden') return null;
  return (
    <button
      type="button"
      aria-pressed={ownVoice}
      disabled={offer !== 'ready'}
      onClick={() => onOwnVoiceChange(!ownVoice)}
      className="inline-flex flex-none items-center justify-center gap-2 rounded-xl border border-line-2 bg-paper/[0.02] px-3 py-2 text-[13.5px] font-medium text-muted [-webkit-tap-highlight-color:transparent] hover:text-paper disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-muted aria-pressed:border-lamp/55 aria-pressed:bg-lamp/[0.09] light:aria-pressed:border-lamp-fill/55 light:aria-pressed:bg-lamp-fill/[0.13] aria-pressed:text-lamp aria-pressed:shadow-[0_0_14px_-4px_var(--lamp-glow)]"
    >
      Own Voice
    </button>
  );
}

/** Why the Own Voice toggle is disabled, with the path to fix it. Renders only
 * on `setup` — an admin-only path must never be offered to a viewer the toggle
 * itself is hidden from, and a null offer (not resolved yet) shows nothing.
 * Every not-`setup` branch lives here, so a call site can hand over whatever it
 * knows without re-deciding. */
export function OwnVoiceUnavailableHint({ offer }: { offer: OwnVoiceOffer | null }) {
  if (offer !== 'setup') return null;
  return (
    <p className="mt-2 text-right text-[11.5px] leading-[1.5] text-dim">
      To sing with your own voice, set it up in{' '}
      <Link
        href="/settings/voice"
        className="text-lamp underline-offset-2 hover:underline [-webkit-tap-highlight-color:transparent]"
      >
        Settings → My Voice
      </Link>
      .
    </p>
  );
}

/** The "start without my profile" row. The card owns the state — it rides the
 * request — so the toggle only presents it; default off (the profile
 * personalizes unless opted out). */
export function SkipProfileToggle({
  checked,
  onCheckedChange,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-end gap-2.5', className)}>
      <div className="text-right">
        <p className="mb-1 text-[15px] font-semibold leading-tight text-paper">
          Run without my profile details
        </p>
        <p className="text-[11.5px] leading-[1.1] text-dim">
          Your own details are not used for this session&rsquo;s lyrics and cover art. People you
          name still are.
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label="Run without my profile details"
        data-testid="skip-profile"
      />
    </div>
  );
}

export function SessionExtras({
  coverStyle,
  onCoverStyleChange,
  useStandardCover,
  onUseStandardCoverChange,
  guardrails,
  onGuardrailsChange,
  children,
}: {
  coverStyle: CoverStyleChoice;
  onCoverStyleChange: (value: CoverStyleChoice) => void;
  useStandardCover: boolean;
  onUseStandardCoverChange: (value: boolean) => void;
  guardrails: GuardrailDraft;
  onGuardrailsChange: (patch: Partial<GuardrailDraft>) => void;
  /** Leading fold(s) sharing this one card — the draft's Fine-tune → Cover
   * art → Guardrails stack. Callers own each fold's divider borders. */
  children?: ReactNode;
}) {
  return (
    <div className="mt-2 overflow-hidden rounded-card border border-line [background:var(--gradient-card)] shadow-[var(--shadow-card)]">
      {children}
      <FoldSection title="Cover Art" embedded>
        <label
          className={cn(
            'flex flex-col gap-2 text-[15px] font-semibold text-paper',
            useStandardCover && 'opacity-40',
          )}
        >
          Cover style
          <CoverStyleSelect
            choices={COVER_STYLE_CHOICES}
            value={coverStyle}
            onChange={onCoverStyleChange}
            disabled={useStandardCover}
            testId="cover-style"
          />
        </label>
        {!useStandardCover && coverStyle === 'custom' ? (
          <p className="mt-2 text-[11.5px] leading-[1.5] text-dim">
            Uses your saved Custom style from{' '}
            <Link href="/settings/cover-art" className="text-muted underline underline-offset-2">
              Settings → Cover Art
            </Link>
            .
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[15px] font-semibold leading-tight text-paper">
              Use custom cover art generation
            </p>
            <p className="text-[11.5px] leading-[1.4] text-dim">
              Off uses the basic art that comes with the music, at no extra cost.
            </p>
          </div>
          <Switch
            checked={!useStandardCover}
            onCheckedChange={(on) => onUseStandardCoverChange(!on)}
            aria-label="Use custom cover art generation"
            data-testid="use-tailored-cover"
          />
        </div>
      </FoldSection>

      <FoldSection title="Guardrails" embedded className="border-t border-line">
        <GuardrailFields value={guardrails} onChange={onGuardrailsChange} />
      </FoldSection>
    </div>
  );
}

/**
 * The Session Guardrails, as every surface that offers them renders them:
 * create and Change Vibe share this one set so a Session's guardrails are read
 * and edited through the same controls. Values are the sliders' own 0-100
 * units; `create-session-model` owns the conversion to the contract's levels.
 */
export function GuardrailFields({
  value,
  onChange,
}: {
  value: GuardrailDraft;
  onChange: (patch: Partial<GuardrailDraft>) => void;
}) {
  return (
    <>
      <PresentationSlider
        label="Follow style"
        value={value.followStyle}
        left="Loose"
        right="Strict"
        onChange={(followStyle) => onChange({ followStyle })}
      />
      <PresentationSlider
        label="Surprise"
        value={value.surprise}
        left="Safe"
        right="Wild"
        onChange={(surprise) => onChange({ surprise })}
      />
      <label className="flex flex-col gap-2 text-[15px] font-semibold text-paper">
        Avoid
        <input
          value={value.avoid}
          onChange={(event) => onChange({ avoid: event.target.value })}
          maxLength={MAX_SESSION_AVOID_LENGTH}
          className={inputClass}
          placeholder="e.g. saxophone, heavy bass drops"
        />
      </label>
    </>
  );
}

function PresentationSlider({
  label,
  value,
  left,
  right,
  onChange,
}: {
  label: string;
  value: number;
  left: string;
  right: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between text-[15px] font-semibold text-paper">
        <span>{label}</span>
        <span className="font-mono text-[11.5px] font-bold tracking-[0.06em] text-lamp">
          {(value / 100).toFixed(2)}
        </span>
      </div>
      <Slider
        className="mt-3"
        value={[value]}
        onValueChange={(next) => onChange(next[0] ?? value)}
        min={0}
        max={100}
        step={1}
        aria-label={label}
      />
      <div className="mt-2 flex justify-between font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}
