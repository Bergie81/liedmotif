'use client';

// Surprise Me: the dice beside the Describe field opens a modal to
// pick how to be surprised, preview the proposal, reroll it, and start it. A
// preview buys no music — that takes Start Session.

import { useEffect, useState } from 'react';
import { Dices, X } from 'lucide-react';
import {
  isSungTheme,
  SURPRISE_THEMES,
  type SurpriseProposal,
  type SurpriseTheme,
  type SurpriseVocal,
} from '@liedmotif/shared';
import { dismissSurprise, proposeSurprise } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import type { SessionLanguageChoice } from '@/lib/session-languages';
import { SessionLanguageSelect } from '@/components/session-language-select';
import {
  chipClass,
  eyebrowClass,
  meterBarClass,
  meterFillClass,
} from '@/components/ui/design-system';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { syntheticProgressFraction } from '@/components/player/cold-start-progress';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { CreationBlockedDialog } from './creation-blocked-dialog';
import { creationRefusalFor, type CreationRefusal } from './creation-refusal';
import { SegmentedControl } from './session-start-controls';
import {
  surpriseExploreLabel,
  surpriseVibeLine,
  surpriseVocalLine,
} from './surprise-preview-lines';

const EXPLORE_OPTIONS = [
  { value: 'familiar', label: 'Familiar' },
  { value: 'adventurous', label: 'Adventurous' },
] as const;
const VOCAL_OPTIONS = [
  { value: 'taste', label: 'Auto' },
  { value: 'instrumental', label: 'Instrumental' },
  { value: 'vocal', label: 'Vocals' },
] as const satisfies ReadonlyArray<{ value: SurpriseVocal; label: string }>;
const THEME_LABELS: Record<SurpriseTheme, string> = {
  any: 'Anything',
  morning: 'Morning',
  focus: 'Focus',
  movement: 'Movement',
  travel: 'On the road',
  home: 'At home',
  friends: 'With friends',
  rest: 'Rest',
  mood: 'A feeling',
  place: 'A place',
  'about-me': 'A song about me',
};

/** What the User asks the next proposal for. */
interface SurpriseSettings {
  theme: SurpriseTheme;
  vocal: SurpriseVocal;
  /** Auto draws the Session language from learned taste, mixing in the listener's other languages. */
  language: SessionLanguageChoice;
  adventurous: boolean;
}

/** A proposal is two text-LLM calls (write, then expand): the synthetic bar's time base, not a promise. */
const EXPECTED_PROPOSAL_MS = 25_000;
const PROGRESS_TICK_MS = 250;
/** One key for the modal's requests, so the next one clears the last one's failure. */
const REQUEST_KEY = 'surprise-me-request';

/** The wait for a proposal, with a time-based bar (the call reports no progress). */
function ProposingProgress({ onCancel }: { onCancel: () => void }) {
  const [fraction, setFraction] = useState(0);
  useEffect(() => {
    const began = Date.now();
    const id = setInterval(
      () => setFraction(syntheticProgressFraction(Date.now() - began, EXPECTED_PROPOSAL_MS)),
      PROGRESS_TICK_MS,
    );
    return () => clearInterval(id);
  }, []);
  const percent = Math.round(fraction * 100);

  return (
    <div data-testid="surprise-proposing">
      <p className="text-[13.5px] leading-relaxed text-muted">Finding a surprise…</p>
      <div
        role="progressbar"
        aria-label="Surprise Me progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className={cn(meterBarClass, 'mt-3')}
      >
        <div
          className={cn(meterFillClass, 'transition-[width] duration-200 ease-linear')}
          style={{ width: `${percent}%` }}
        />
      </div>
      <button type="button" onClick={onCancel} className={cn(secondaryButtonClass, 'mt-5 w-full')}>
        Cancel
      </button>
    </div>
  );
}

/** The settings step: what to be surprised with, and the button that asks for it. */
function SurpriseSettingsForm({
  settings,
  onChange,
  onFind,
}: {
  settings: SurpriseSettings;
  onChange: (patch: Partial<SurpriseSettings>) => void;
  onFind: () => void;
}) {
  const sungTheme = isSungTheme(settings.theme);
  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-[13px] font-semibold text-paper">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {SURPRISE_THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              aria-pressed={settings.theme === theme}
              onClick={() => onChange({ theme })}
              className={chipClass}
            >
              {THEME_LABELS[theme]}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-2 text-[13px] font-semibold text-paper">
        Language
        <SessionLanguageSelect
          value={settings.language}
          onChange={(language) => onChange({ language })}
          ariaLabel="Session language"
          testId="surprise-language"
          triggerClassName="w-full"
          autoLabel="Auto"
        />
      </label>
      <SegmentedControl
        label="Vocals"
        value={sungTheme ? 'vocal' : settings.vocal}
        options={VOCAL_OPTIONS}
        onChange={(vocal) => onChange({ vocal })}
        disabled={sungTheme}
      />
      <SegmentedControl
        label="Explore"
        value={settings.adventurous ? 'adventurous' : 'familiar'}
        options={EXPLORE_OPTIONS}
        onChange={(value) => onChange({ adventurous: value === 'adventurous' })}
      />
      <button type="button" onClick={onFind} className={cn(primaryButtonClass, 'w-full')}>
        Find a surprise
      </button>
    </div>
  );
}

/** The preview step: the proposal and what to do with it. */
function SurprisePreview({
  proposal,
  starting,
  disabled,
  onStart,
  onTryAnother,
  onChangeSettings,
  onDismiss,
}: {
  proposal: SurpriseProposal;
  starting: boolean;
  /** Another request is in flight. */
  disabled: boolean;
  onStart: () => void;
  onTryAnother: () => void;
  onChangeSettings: () => void;
  onDismiss: () => void;
}) {
  const locked = disabled || starting;
  return (
    <div data-testid="surprise-preview">
      <div className="rounded-card-sm border border-line-2 bg-paper/[0.03] p-4">
        <p className={eyebrowClass}>{surpriseExploreLabel(proposal)}</p>
        <p className="mt-2 font-display text-[18px] font-bold leading-tight text-paper">
          {proposal.title}
        </p>
        <p className="mt-2 text-[13.5px] leading-[1.5] text-muted">{surpriseVibeLine(proposal)}</p>
        <p className="mt-1 text-[13.5px] leading-[1.5] text-muted">{surpriseVocalLine(proposal)}</p>
      </div>
      <button
        type="button"
        onClick={onStart}
        disabled={locked}
        className={cn(primaryButtonClass, 'mt-4 w-full')}
      >
        {starting ? <LiedmotifLoader /> : null}
        {starting ? 'Starting…' : 'Start Session'}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onTryAnother}
          disabled={locked}
          className={secondaryButtonClass}
        >
          Try another
        </button>
        <button
          type="button"
          onClick={onChangeSettings}
          disabled={locked}
          className="px-2 py-2 text-[13px] font-semibold text-muted hover:text-paper disabled:opacity-50"
        >
          Change settings
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={locked}
          className="ml-auto px-2 py-2 text-[13px] font-semibold text-dim hover:text-muted disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function SurpriseMe({
  skipProfile,
  initialProposal = null,
  starting,
  onProposalChange,
  onStart,
}: {
  /** The card's Start-without-profile switch: a proposal made under it reads no profile or People. */
  skipProfile: boolean;
  /** The proposal already pending when the page rendered. */
  initialProposal?: SurpriseProposal | null;
  /** The card is starting a Session. */
  starting: boolean;
  /** The shown proposal changed: a new one arrived, or it was dismissed. */
  onProposalChange?: (proposal: SurpriseProposal | null) => void;
  /** Start the previewed proposal as a Session. */
  onStart: (proposal: SurpriseProposal) => void;
}) {
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<SurpriseProposal | null>(initialProposal);
  const [settings, setSettings] = useState<SurpriseSettings>({
    theme: 'any',
    vocal: 'taste',
    language: 'auto',
    adventurous: initialProposal?.adventurous ?? false,
  });
  // The preview is shown over the settings until the User asks to change them.
  const [editingSettings, setEditingSettings] = useState(false);
  // A suggestion made elsewhere (Roadie) arrives as a new pending one on the
  // page's next render, and replaces the one shown.
  const [seenInitial, setSeenInitial] = useState(initialProposal);
  if (initialProposal?.id !== seenInitial?.id) {
    setSeenInitial(initialProposal);
    if (initialProposal && initialProposal.id !== proposal?.id) {
      setProposal(initialProposal);
      setSettings((current) => ({ ...current, adventurous: initialProposal.adventurous }));
      setEditingSettings(false);
    }
  }
  // The proposal request in flight; Cancel aborts it and nothing it answers lands.
  const [proposing, setProposing] = useState<AbortController | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [blocked, setBlocked] = useState<CreationRefusal | null>(null);

  const busy = proposing !== null || dismissing;
  const step = proposing ? 'proposing' : proposal && !editingSettings ? 'preview' : 'settings';

  /** Opening and closing both start over from the first step. */
  function setDialogOpen(next: boolean) {
    setEditingSettings(false);
    setOpen(next);
  }

  async function propose() {
    if (busy) return;
    const request = new AbortController();
    setProposing(request);
    toast.dismiss(REQUEST_KEY);
    const { theme, vocal, language, adventurous } = settings;
    const result = await proposeSurprise(
      {
        adventurous,
        skipProfile,
        theme,
        vocal: isSungTheme(theme) ? 'vocal' : vocal,
        ...(language !== 'auto' ? { language } : {}),
        replaces: proposal?.id ?? null,
      },
      request.signal,
    );
    if (request.signal.aborted) return;
    setProposing(null);
    // A failure leaves the proposal on screen exactly as it was.
    if (result.ok) {
      setProposal(result.data.proposal);
      setEditingSettings(false);
      onProposalChange?.(result.data.proposal);
      return;
    }
    const refusal = creationRefusalFor(result.error);
    if (refusal) {
      setOpen(false);
      setBlocked(refusal);
    } else toast.error(result.error.message, { key: REQUEST_KEY });
  }

  function cancelProposing() {
    proposing?.abort();
    setProposing(null);
    setDialogOpen(false);
  }

  async function dismiss() {
    if (busy || !proposal) return;
    setDismissing(true);
    toast.dismiss(REQUEST_KEY);
    const result = await dismissSurprise(proposal.id);
    setDismissing(false);
    // Already gone elsewhere is the outcome the User asked for.
    if (result.ok || result.error.code === 'not_found') {
      setProposal(null);
      setEditingSettings(false);
      onProposalChange?.(null);
    } else toast.error(result.error.message, { key: REQUEST_KEY });
  }

  function changeOpen(next: boolean) {
    // A stray click or Escape must not lose the wait: only Cancel ends it.
    if (!next && proposing) return;
    setDialogOpen(next);
  }

  return (
    <>
      <button
        type="button"
        data-testid="surprise-me-button"
        onClick={() => changeOpen(true)}
        aria-label="Surprise Me"
        title="Surprise Me"
        className="group relative isolate flex h-[50px] w-[50px] shrink-0 items-center justify-center overflow-hidden rounded-[13px] border border-line-2 bg-paper/[0.03] text-paper transition-[color,border-color,box-shadow] duration-150 before:absolute before:inset-0 before:-z-10 before:opacity-0 before:transition-opacity before:duration-150 before:[background:var(--gradient-primary)] hover:border-transparent hover:text-[var(--on-lamp)] hover:shadow-[var(--shadow-primary)] hover:before:opacity-100 focus-visible:border-paper/35"
      >
        <Dices
          className="h-[21px] w-[21px] transition-transform duration-200 ease-out group-hover:rotate-[20deg] motion-reduce:transition-none motion-reduce:group-hover:rotate-0"
          aria-hidden
        />
      </button>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          data-testid="surprise-me"
          // Only the settings step carries the description; the others opt out of it.
          {...(step === 'settings' ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-center gap-2">
            <Dices className="h-5 w-5 text-lamp" aria-hidden />
            <DialogTitle className="font-display text-[18px] font-bold text-paper">
              Surprise Me
            </DialogTitle>
            {step === 'proposing' ? null : (
              <DialogClose
                aria-label="Close"
                className="ml-auto rounded-lg p-1 text-dim hover:text-paper"
              >
                <X className="h-5 w-5" aria-hidden />
              </DialogClose>
            )}
          </div>
          {step === 'settings' ? (
            <DialogDescription className="mt-1 text-[13px] leading-relaxed text-dim">
              Get a fresh Session idea shaped by your listening taste. Pick a theme, try ideas until
              one fits, then start it.
            </DialogDescription>
          ) : null}

          <div className="mt-4">
            {step === 'proposing' ? <ProposingProgress onCancel={cancelProposing} /> : null}
            {step === 'preview' && proposal ? (
              <SurprisePreview
                proposal={proposal}
                starting={starting}
                disabled={busy}
                onStart={() => onStart(proposal)}
                onTryAnother={propose}
                onChangeSettings={() => setEditingSettings(true)}
                onDismiss={dismiss}
              />
            ) : null}
            {step === 'settings' ? (
              <SurpriseSettingsForm
                settings={settings}
                onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
                onFind={propose}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {blocked ? (
        <CreationBlockedDialog
          open
          onOpenChange={(next) => {
            if (!next) setBlocked(null);
          }}
          refusal={blocked}
        />
      ) : null}
    </>
  );
}
