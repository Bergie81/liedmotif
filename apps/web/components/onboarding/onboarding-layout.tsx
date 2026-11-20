// The chrome every onboarding step sits in — the content column, the sticky overview
// rail, the mobile progress strip, the stacked action bar — and the cards, notes, and
// rows the steps fill it with.
//
// The rail is present from the first step, so the shape of the setup is knowable up
// front rather than a screen at a time; under the step list it doubles as a record of
// what has actually been set.

'use client';

import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  cardClass,
  displayHeadingClass,
  eyebrowClass,
  meterBarClass,
  meterFillClass,
  LiedmotifMark,
  LiedmotifWordmark,
} from '@/components/ui/design-system';
import { SettingsControlRow, SettingsFeedback } from '@/components/settings/settings-ui';
import { Stepper } from '@/components/ui/controls';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import {
  ONBOARDING_GROUPS,
  ONBOARDING_STEPS,
  onboardingProgress,
  type OnboardingGroupTable,
  type OnboardingRecordRow,
  type OnboardingStepId,
} from './onboarding-model';

export function OnboardingShell({ children, rail }: { children: ReactNode; rail: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[560px] px-4 pb-16 pt-6 desk:grid desk:max-w-[1260px] desk:grid-cols-[minmax(0,1fr)_300px] desk:items-start desk:gap-16 desk:px-10 desk:pb-16 desk:pt-11">
      <div className="min-w-0">
        {/* The mark rides above every step, so the flow reads as one place rather
            than a series of forms. */}
        <div className="mb-6 flex items-center gap-3">
          <LiedmotifMark className="h-[30px] w-[30px]" />
          <LiedmotifWordmark className="text-[30px]" />
        </div>
        {children}
      </div>
      {rail}
    </main>
  );
}

function railStepState(index: number, currentIndex: number): 'here' | 'done' | 'ahead' {
  if (index === currentIndex) return 'here';
  return index < currentIndex ? 'done' : 'ahead';
}

export function OnboardingRail({
  currentIndex,
  furthestIndex,
  record,
  onSelect,
  groups = ONBOARDING_GROUPS,
  steps: flatSteps = ONBOARDING_STEPS,
}: {
  currentIndex: number;
  /** The furthest step reached; anything past it is not yet navigable. */
  furthestIndex: number;
  record: OnboardingRecordRow[];
  onSelect: (index: number) => void;
  /** The step table to walk — the Admin's full setup by default. */
  groups?: OnboardingGroupTable;
  steps?: typeof ONBOARDING_STEPS;
}) {
  const currentGroup = flatSteps[currentIndex]?.group;
  // The rail walks the group table but numbers each step from the flat one, so a
  // step's position is always the number the mobile strip counts to.
  function positionOf(id: OnboardingStepId): number {
    return flatSteps.findIndex((step) => step.id === id);
  }

  return (
    <nav aria-label="Setup steps" className="sticky top-11 hidden desk:block">
      {groups.map(({ group, steps }) => (
        <div key={group} className="mb-5 last:mb-0">
          <p
            className={cn(
              'mb-2 font-mono text-[9.5px] font-bold uppercase tracking-[0.2em]',
              group === currentGroup ? 'text-lamp' : 'text-dim',
            )}
          >
            {group}
          </p>
          {steps.map((step) => {
            const index = positionOf(step.id);
            const state = railStepState(index, currentIndex);
            return (
              <button
                key={step.id}
                type="button"
                disabled={index > furthestIndex}
                aria-current={state === 'here' ? 'step' : undefined}
                onClick={() => onSelect(index)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-[9px] px-2.5 py-[7px] text-left text-[13.5px] [-webkit-tap-highlight-color:transparent] disabled:cursor-not-allowed',
                  state === 'here' && 'bg-[var(--control-bg)] font-semibold text-paper',
                  state === 'done' && 'text-muted hover:bg-[var(--control-bg-hover)]',
                  state === 'ahead' && 'text-dim enabled:hover:bg-[var(--control-bg-hover)]',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'grid h-[15px] w-[15px] flex-none place-items-center rounded-full border-[1.5px] font-mono text-[8px] font-bold',
                    state === 'done' && 'border-signal bg-signal text-night',
                    state === 'here' &&
                      'border-lamp text-transparent shadow-[0_0_0_3px_var(--lamp-glow)]',
                    state === 'ahead' && 'border-line-2 text-transparent',
                  )}
                >
                  ✓
                </span>
                {step.title}
                {step.optional ? (
                  <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.12em] text-dim">
                    Optional
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}

      <dl className="mt-6 border-t border-line pt-5">
        <p className="mb-2 font-mono text-[9.5px] font-bold uppercase tracking-[0.2em] text-dim">
          Set So Far
        </p>
        {record.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]"
          >
            <dt className="text-dim">{row.label}</dt>
            <dd
              className={cn(
                'min-w-0 truncate text-right',
                row.muted ? 'text-dim' : 'font-semibold text-paper',
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </nav>
  );
}

export function OnboardingStrip({
  currentIndex,
  steps = ONBOARDING_STEPS,
}: {
  currentIndex: number;
  steps?: typeof ONBOARDING_STEPS;
}) {
  const progress = onboardingProgress(currentIndex, steps);
  return (
    <div className="mb-6 desk:hidden">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-lamp">
          {progress.group}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">
          Step {progress.position} of {progress.total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={progress.total}
        aria-valuenow={progress.position}
        className={meterBarClass}
      >
        <div className={meterFillClass} style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

export function OnboardingBackLink({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2.5 mb-3 inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-2 font-mono text-[11px] uppercase tracking-[0.1em] text-dim hover:bg-[var(--control-bg-hover)] hover:text-paper"
    >
      <ChevronLeft className="h-[13px] w-[13px]" aria-hidden />
      Back to {label}
    </button>
  );
}

export function OnboardingStepHeader({
  eyebrow,
  eyebrowTone = 'muted',
  title,
  children,
}: {
  eyebrow?: string;
  eyebrowTone?: 'muted' | 'required';
  title: string;
  children: ReactNode;
}) {
  return (
    <header>
      {eyebrow ? (
        <p className={cn(eyebrowClass, eyebrowTone === 'required' && 'text-lamp')}>{eyebrow}</p>
      ) : null}
      <h1 className={cn(displayHeadingClass, 'mt-1.5')}>{title}</h1>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{children}</p>
    </header>
  );
}

/** A section heading inside a step, matching the settings surfaces' rhythm. */
export function OnboardingSubhead({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3 mt-6 flex items-center gap-2.5">
      {icon ? <span className="flex-none text-lamp">{icon}</span> : null}
      <h2 className="font-display text-[16.5px] font-bold tracking-[-0.01em]">{children}</h2>
    </div>
  );
}

/** An environment variable named mid-sentence. */
export function EnvVar({ children }: { children: ReactNode }) {
  return <code className="[font-family:monospace] text-[12px] text-paper">{children}</code>;
}

/** The sunk paragraph that translates a ceiling into something meaningful. */
export function OnboardingNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 rounded-card-sm border border-line bg-[var(--segment-bg)] px-3.5 py-3 text-[13px] leading-[1.55] text-muted">
      {children}
    </p>
  );
}

export function OnboardingCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(cardClass, 'mt-5', className)}>{children}</div>;
}

/** The step's actions: one primary decision, stacked, full width. */
export function OnboardingActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-col gap-2.5">{children}</div>;
}

/** The step's one way forward, carrying the loader while it writes. */
export function OnboardingPrimaryAction({
  label,
  busyLabel,
  busy = false,
  disabled = false,
  icon,
  onClick,
}: {
  label: string;
  /** Stands in for the label while the write is in flight. */
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className={cn(primaryButtonClass, 'w-full')}
    >
      {busy ? <LiedmotifLoader size="xs" /> : icon}
      {busy && busyLabel ? busyLabel : label}
    </button>
  );
}

/** A step's failure, in the one place every step reports one. */
export function OnboardingError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mt-4">
      <SettingsFeedback kind="error">{error}</SettingsFeedback>
    </div>
  );
}

/** Where the same setting lives afterwards, so nothing feels like a one-shot. */
function OnboardingAftercare({ children }: { children: ReactNode }) {
  return <p className="pt-1 text-center text-[13px] font-medium text-dim">{children}</p>;
}

/** A stepper row: the setting, what it costs, and the control that moves it. */
export function OnboardingLimitRow({
  label,
  description,
  value,
  unit,
  step,
  min = 0,
  max,
  disabled,
  onStep,
}: {
  label: string;
  description: string;
  value: string;
  unit: 'trk' | 'cov';
  step: number;
  min?: number;
  max?: number;
  disabled: boolean;
  onStep: (amount: number) => void;
}) {
  const current = Number(value);
  return (
    <SettingsControlRow label={label} description={description}>
      <Stepper
        value={`${value} ${unit}`}
        onDecrement={() => onStep(-step)}
        onIncrement={() => onStep(step)}
        decrementLabel={`Decrease ${label}`}
        incrementLabel={`Increase ${label}`}
        canDecrement={!disabled && current > min}
        canIncrement={!disabled && (max === undefined || current < max)}
      />
    </SettingsControlRow>
  );
}

/** The commit for a spend screen: the failure to read, then the one way forward. */
export function OnboardingSpendActions({
  label,
  saving,
  error,
  onCommit,
}: {
  label: string;
  saving: boolean;
  error: string | null;
  onCommit: () => void;
}) {
  return (
    <>
      <OnboardingError error={error} />
      <OnboardingActions>
        <OnboardingPrimaryAction
          label={label}
          busyLabel="Saving…"
          busy={saving}
          onClick={onCommit}
        />
        <OnboardingAftercare>Change these any time in Settings › Generation</OnboardingAftercare>
      </OnboardingActions>
    </>
  );
}
