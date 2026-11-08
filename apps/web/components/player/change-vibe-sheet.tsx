'use client';

import { useEffect, useRef, useState } from 'react';
import {
  DURATION_TARGET_REACHED_MESSAGE,
  MAX_USER_PROMPT_LENGTH,
  isDurationTargetReached,
  type ChangeVibeIntentInput,
  type SessionVibe,
} from '@liedmotif/shared';
import { SessionDurationControl } from '@/components/create/session-duration-control';
import { GenreHintField } from '@/components/create/genre-hint-field';
import {
  FoldSection,
  GuardrailFields,
  OwnVoiceUnavailableHint,
  SegmentedControl,
  SessionLanguageField,
} from '@/components/create/session-start-controls';
import { MAX_GENRES } from '@/components/create/genre-vocabulary';
import { Switch } from '@/components/ui/controls';
import { inputClass, primaryButtonClass } from '@/components/ui/form-styles';
import { Sheet, SheetContent, SheetHeader, SheetTrigger } from '@/components/ui/sheet';
import { requestVoiceProfile, type ChangeVibeOptions } from '@/lib/api-client';
import { useAppChrome } from '@/components/app-chrome-context';
import { cn } from '@/lib/cn';
import type { OwnVoiceOffer } from '@/lib/voice';
import { ChangeVibeGlyph } from '@/components/ui/glyphs';
import {
  buildChangeVibeRequest,
  hasPickChanges,
  vibeToPicks,
  type ChangeVibePicks,
} from './change-vibe-model';

export function ChangeVibeSheet({
  vibe,
  targetDurationMinutes = null,
  generatedDurationSeconds = 0,
  disabled,
  switchNowLocked,
  triggerClassName,
  open,
  onOpenChange,
  onSubmit,
}: {
  vibe: SessionVibe | null;
  targetDurationMinutes?: number | null;
  /** Usable generated music so far — what the duration target counts. */
  generatedDurationSeconds?: number;
  disabled: boolean;
  /** A live repeat-one loop blocks new paid jobs, so switch-now cannot deliver
   *  while it holds — the toggle is offered disabled. */
  switchNowLocked: boolean;
  triggerClassName: string;
  /** Parent-owned open state, so the player options menu can open this sheet
   * too — its own trigger button is just one of the ways in. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fire-and-forget: the sheet closes at once and the request runs at
   * provider scope — the player's cover chip and slider status narrate it,
   * and a failure lands on the player error surface. */
  onSubmit: (input: ChangeVibeIntentInput | undefined, options: ChangeVibeOptions) => void;
}) {
  const { ownVoiceOffered } = useAppChrome();
  const [prompt, setPrompt] = useState('');
  const [initialTarget, setInitialTarget] = useState<number | null>(targetDurationMinutes);
  const [target, setTarget] = useState<number | null>(targetDurationMinutes);
  const [initial, setInitial] = useState<ChangeVibePicks>(() => vibeToPicks(null));
  const [picks, setPicks] = useState<ChangeVibePicks>(initial);
  const [switchNow, setSwitchNow] = useState(false);
  // The own-voice offer, split by stability: the structural half (role and the
  // instance switch, fixed for the login) comes from the app-shell context, the
  // dynamic half (is the profile ready NOW) is fetched when the sheet opens;
  // null while unknown. A viewer not offered the feature (a Member, or any
  // viewer while the instance switch is off) resolves `hidden` without ever
  // firing the admin-only fetch. A session already singing with the user's
  // voice always shows the control so it can be turned OFF even after the
  // profile went away.
  const [ownVoiceOffer, setOwnVoiceOffer] = useState<OwnVoiceOffer | null>(null);

  // The preselection is captured on the OPEN EDGE (deliberately not
  // live-updated): the user edits against the vibe they saw, and the diff
  // decides what is sent — so `open` is the only dependency, and the ref keeps
  // the reset one-shot per open. An edge-guarded effect rather than a trigger
  // callback, so opening from the options menu (parent-set `open`) resets the
  // form exactly like the trigger button does.
  const prevOpenRef = useRef(false);
  // Whether this open's preselection came from a loaded vibe. A sheet opened
  // before the queue poll delivered one shows placeholder defaults, and a diff
  // against placeholders would overwrite the Session's real vibe — so the first
  // vibe to arrive while open becomes the preselection.
  const seededFromVibeRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open || wasOpen) return;
    const preselected = vibeToPicks(vibe);
    seededFromVibeRef.current = vibe != null;
    setInitial(preselected);
    setInitialTarget(targetDurationMinutes);
    setTarget(targetDurationMinutes);
    setPicks(preselected);
    setPrompt('');
    setSwitchNow(false);
    if (!ownVoiceOffered) {
      setOwnVoiceOffer('hidden');
      return;
    }
    void requestVoiceProfile('/api/settings/voice').then((result) =>
      setOwnVoiceOffer(result.ok && result.data.profile.availableForSessions ? 'ready' : 'setup'),
    );
  }, [open, ownVoiceOffered]);
  useEffect(() => {
    if (!open || vibe == null || seededFromVibeRef.current) return;
    seededFromVibeRef.current = true;
    const preselected = vibeToPicks(vibe);
    setInitial(preselected);
    setPicks(preselected);
  }, [open, vibe]);

  const creativeChange = prompt.trim().length > 0 || hasPickChanges(initial, picks);
  const durationChanged = initialTarget !== target;
  // At the target a new vibe could never fill; the same edit can lift or clear it.
  const targetReached = isDurationTargetReached(target, generatedDurationSeconds);
  const built = buildChangeVibeRequest({
    message: prompt,
    vibe,
    initial,
    picks,
    initialTarget,
    target,
    generatedDurationSeconds,
  });
  // A locked toggle can never take effect: the held loop blocks the paid job.
  const switchImmediately = switchNow && !switchNowLocked;

  function submit() {
    if (!built.ok) return;
    onSubmit(built.input, {
      switchImmediately,
      targetDurationMinutes: built.targetDurationMinutes,
    });
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button type="button" disabled={disabled} className={triggerClassName}>
          <ChangeVibeGlyph className="h-6 w-6 shrink-0" />
          <span>Change Vibe</span>
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="flex max-h-[86vh] flex-col">
        <SheetHeader
          title="Change Vibe"
          description="Choose a new direction for newly generated tracks without starting a new Session."
        />
        <div className="-mx-5 mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5">
          <label htmlFor="change-vibe-prompt" className="mt-4 block text-[13px] font-semibold">
            New direction
          </label>
          <textarea
            id="change-vibe-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Warmer, slower, more acoustic…"
            maxLength={MAX_USER_PROMPT_LENGTH}
            className={cn(inputClass, 'mt-2 min-h-[80px] resize-y')}
          />
          <div className="mt-3 overflow-hidden rounded-card border border-line [background:var(--gradient-card)] shadow-[var(--shadow-card)]">
            {/* Opened on a Session already at its target, so the notice that
                explains the held Change Vibe is in view. */}
            <FoldSection
              title="Session Details"
              embedded
              defaultOpen={isDurationTargetReached(targetDurationMinutes, generatedDurationSeconds)}
            >
              {/* These picks are captured from the live Style Snapshot when the
                  sheet opens. Only edits ride a free-text change. */}
              <div className="flex flex-col gap-6">
                <div>
                  <SessionDurationControl value={target} onChange={setTarget} />
                  {targetReached ? (
                    <p role="status" className="mt-2 text-[11.5px] leading-[1.5] text-warn">
                      {DURATION_TARGET_REACHED_MESSAGE}
                    </p>
                  ) : null}
                </div>
                <GenreHintField
                  selected={picks.genres}
                  onChange={(genres) => setPicks((p) => ({ ...p, genres }))}
                  hint={`PICK UP TO ${MAX_GENRES} GENRES`}
                  shortlist="selected-only"
                />
                <SegmentedControl
                  label="Energy"
                  value={picks.energy}
                  options={[
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                  ]}
                  onChange={(energy) => setPicks((p) => ({ ...p, energy }))}
                />
                <SegmentedControl
                  label="Vocals"
                  value={picks.vocal}
                  options={[
                    { value: 'instrumental', label: 'Instrumental' },
                    { value: 'vocal', label: 'Vocals' },
                  ]}
                  onChange={(vocal) => setPicks((p) => ({ ...p, vocal }))}
                />
                {picks.vocal === 'vocal' ? (
                  <>
                    {/* Own voice supersedes the gender question. The control is
                        offered only with a usable profile (or to turn an active
                        own-voice session OFF); the server still rejects an
                        unusable pick before any spend as the backstop. */}
                    {ownVoiceOffer === 'ready' || picks.ownVoice ? (
                      <SegmentedControl
                        label="Singer"
                        value={picks.ownVoice ? 'own' : 'generic'}
                        options={[
                          { value: 'generic', label: 'Generic' },
                          { value: 'own', label: 'My voice' },
                        ]}
                        onChange={(singer) =>
                          setPicks((p) => ({ ...p, ownVoice: singer === 'own' }))
                        }
                      />
                    ) : (
                      <OwnVoiceUnavailableHint offer={ownVoiceOffer} />
                    )}
                    {!picks.ownVoice ? (
                      <SegmentedControl
                        label="Voice"
                        value={picks.voice}
                        options={[
                          { value: 'any', label: 'Any' },
                          { value: 'female', label: 'Female' },
                          { value: 'male', label: 'Male' },
                        ]}
                        onChange={(voice) => setPicks((p) => ({ ...p, voice }))}
                      />
                    ) : null}
                  </>
                ) : null}
                <SessionLanguageField
                  value={picks.language}
                  onChange={(language) => setPicks((p) => ({ ...p, language }))}
                />
              </div>
            </FoldSection>
            {/* The same Guardrails fold the create screen offers, seeded with
                the Session's frozen values — changing one is a real vibe
                change and buys the new revision's first tracks. */}
            <FoldSection title="Guardrails" embedded className="border-t border-line">
              <GuardrailFields
                value={picks}
                onChange={(patch) => setPicks((p) => ({ ...p, ...patch }))}
              />
            </FoldSection>
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold leading-tight text-paper">
                Switch to the new vibe as soon as it&rsquo;s ready
              </p>
              <p className="text-[11.5px] leading-[1.4] text-dim">
                {switchNowLocked
                  ? 'Unavailable while a track loop is on — looping pauses new generation.'
                  : 'Current track keeps playing; upcoming tracks from the old vibe are set aside (they stay in this Session).'}
              </p>
            </div>
            <Switch
              checked={switchImmediately}
              onCheckedChange={setSwitchNow}
              disabled={switchNowLocked}
              aria-label="Switch to the new vibe as soon as it’s ready"
              data-testid="change-vibe-switch-now"
              className="disabled:cursor-not-allowed disabled:opacity-40"
            />
          </div>
        </div>
        <button
          type="button"
          disabled={!built.ok}
          onClick={submit}
          className={cn(primaryButtonClass, 'mt-4 w-full shrink-0')}
        >
          {durationChanged && !creativeChange ? 'Save duration' : 'Change Vibe'}
        </button>
      </SheetContent>
    </Sheet>
  );
}
