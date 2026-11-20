'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CoverStyleChoice,
  SessionIntentInput,
  StartSessionRequest,
  StartSurpriseRequest,
  SurpriseProposal,
} from '@liedmotif/shared';
import type { ApiResult } from '@/lib/http/api-client';
import { cn } from '@/lib/cn';
import type { SessionLanguageChoice } from '@/lib/sessions/session-languages';
import type { OwnVoiceOffer } from '@/lib/voice/voice';
import { useClientId } from '@/lib/use-client-id';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { OnlineOnly } from '@/components/ui/online-only';
import { sectionHeadingClass } from '@/components/ui/design-system';
import { toast } from '@/lib/toast';
import { DescribeFineTuneSection, DescribeSessionPanel } from './describe-session-panel';
import { SessionDurationControl } from './session-duration-control';
import { useSeededPrompt } from './use-seeded-prompt';
import { SessionExtras } from './session-start-controls';
import { SurpriseMe } from './surprise-me';
import {
  buildPromptIntent,
  buildStartRequest,
  DEFAULT_GUARDRAIL_DRAFT,
  formMatchesSurprise,
  surpriseFineTune,
  type DescribeFineTune,
  type GuardrailDraft,
} from './create-session-model';

const START_KEY = 'create-session-start';

/** Everything the card holds for the next Session beyond the prompt text: the
 * fine-tune picks and the Guardrails fold. It IS the pick set `buildPromptIntent`
 * takes, so the card hands it over whole instead of re-mapping it field by field. */
interface CreateSessionDraft extends DescribeFineTune {
  guardrails: GuardrailDraft;
}

export function CreateSessionCard({
  onStart,
  llmConfigured,
  initialPrompt,
  defaultCoverStyle = 'auto',
  defaultUseStandardCover = false,
  defaultLanguage = 'auto',
  forYouGenres = [],
  ownVoiceOffer = 'hidden',
  surprise,
}: {
  onStart: (request: StartSessionRequest) => void;
  llmConfigured: boolean;
  /** Seeds the Describe field once (the search hand-off), ready to review — never auto-submitted. */
  initialPrompt?: string;
  defaultCoverStyle?: CoverStyleChoice;
  /** The owner's Settings → Cover art default for the standard-cover toggle. */
  defaultUseStandardCover?: boolean;
  /** The owner's Settings → Generation default; each Session can override it. */
  defaultLanguage?: SessionLanguageChoice;
  /** The User's For you genres from learned taste (ranked); empty means curated defaults. */
  forYouGenres?: readonly string[];
  /** How "Use my voice" is offered; defaults to `hidden` so a surface that
   * forgets to pass it shows nothing rather than a control it cannot justify. */
  ownVoiceOffer?: OwnVoiceOffer;
  /** Offer Surprise Me beside the input, opening on the pending proposal (if
   * any). Omitted = the surface has no Surprise Me. */
  surprise?: {
    pending: SurpriseProposal | null;
    /** The handed-off Start's result, or null when another Start was in flight. */
    onStart: (request: StartSurpriseRequest) => Promise<ApiResult<unknown>> | null;
  };
}) {
  const clientId = useClientId();
  const router = useRouter();
  // The proposal Surprise Me is showing. A search hand-off outranks a pending
  // one for the form's opening words: it is what the User just asked for.
  const [proposal, setProposal] = useState(surprise?.pending ?? null);
  const seed = initialPrompt ? null : proposal;
  // Whether the form holds the shown proposal's prefill: not while a search
  // hand-off's words outrank it.
  const [formHoldsProposal, setFormHoldsProposal] = useState(seed != null);
  const [prompt, setPrompt] = useSeededPrompt(initialPrompt ?? seed?.edit.prompt);
  const [draft, setDraft] = useState<CreateSessionDraft>(() => ({
    genres: [],
    energy: 'auto',
    vocal: 'auto',
    voice: 'any',
    ownVoice: false,
    language: defaultLanguage,
    ...(seed ? surpriseFineTune(seed.edit) : {}),
    guardrails: DEFAULT_GUARDRAIL_DRAFT,
  }));
  const [targetDurationMinutes, setTargetDurationMinutes] = useState<number | null>(
    seed?.edit.durationMinutes ?? null,
  );
  const [coverStyle, setCoverStyle] = useState<CoverStyleChoice>(defaultCoverStyle);
  const [useStandardCover, setUseStandardCover] = useState(defaultUseStandardCover);
  // Start-without-profile (default off): reset by the card's unmount on
  // navigation — a fresh visit always personalizes again.
  const [skipProfile, setSkipProfile] = useState(false);
  // A handed-off start navigates to /player, which unmounts this card; until
  // that lands the button must show the click was taken.
  const [starting, setStarting] = useState(false);
  // A suggestion made elsewhere (Roadie) reaches the page as a new pending one
  // on its next render, and replaces the one shown.
  const pendingId = surprise?.pending?.id ?? null;
  const [seenPendingId, setSeenPendingId] = useState(pendingId);
  if (pendingId !== seenPendingId) {
    setSeenPendingId(pendingId);
    if (surprise?.pending && pendingId !== proposal?.id) showProposal(surprise.pending);
  }
  function durationOf(minutes: number | null) {
    return minutes != null ? { targetDurationMinutes: minutes } : {};
  }

  function startSession() {
    if (starting) return;
    toast.dismiss(START_KEY);
    const result = buildPromptIntent(prompt, draft);
    if (!result.ok) {
      toast.error(result.error, { key: START_KEY });
      return;
    }
    // The untouched proposal starts from its stored Style Snapshot, so the
    // Session is the one previewed and no second expansion is bought. The
    // snapshot already holds (or lacks) profile context, so a flipped Start
    // without profile makes it the User's own request too.
    if (
      surprise &&
      proposal &&
      proposal.skipProfile === skipProfile &&
      formMatchesSurprise(prompt, draft, proposal.edit)
    ) {
      startProposal(proposal, targetDurationMinutes);
      return;
    }
    startOwnRequest(result.intent, targetDurationMinutes);
  }

  function startOwnRequest(intent: SessionIntentInput, minutes: number | null) {
    setStarting(true);
    onStart({
      ...buildStartRequest(intent, clientId, { coverStyle, skipProfile, useStandardCover }),
      ...durationOf(minutes),
    });
  }

  /** Start a proposal from its stored Style Snapshot, with the card's cover and the given length. */
  function startProposal(next: SurpriseProposal, minutes: number | null) {
    if (!surprise || starting) return;
    setStarting(true);
    const started = surprise.onStart({
      proposalId: next.id,
      ...(coverStyle !== 'auto' ? { coverStyle } : {}),
      useStandardCover,
      ...durationOf(minutes),
    });
    // Replaced elsewhere: the router's cached Home still holds this dead
    // proposal, so the next visit must read the pending one afresh. Nothing
    // starts in its place; the User sees the current one and decides.
    void started?.then((result) => {
      if (!result.ok && result.error.code === 'conflict') router.refresh();
    });
  }

  // The modal's Start starts what the modal previews: the proposal's words and
  // picks, with the card's length only once the form holds the proposal. A
  // proposal made under the other Start without profile setting holds (or
  // lacks) profile context its snapshot cannot shed, so it starts as the User's
  // own request built from that prefill, with the User's own Guardrails.
  function startFromModal(next: SurpriseProposal) {
    if (starting) return;
    toast.dismiss(START_KEY);
    const minutes = formHoldsProposal ? targetDurationMinutes : next.edit.durationMinutes;
    if (next.skipProfile === skipProfile) {
      startProposal(next, minutes);
      return;
    }
    const result = buildPromptIntent(next.edit.prompt, {
      ...draft,
      ...surpriseFineTune(next.edit),
    });
    if (result.ok) startOwnRequest(result.intent, minutes);
    else toast.error(result.error, { key: START_KEY });
  }

  // The pending proposal as the server holds it now: the card starts that one,
  // but the form keeps the User's words, so it no longer counts as untouched.
  function holdProposal(next: SurpriseProposal | null) {
    if (next?.id === proposal?.id) return;
    setProposal(next);
    setFormHoldsProposal(false);
  }

  // A proposal's words, picks and length land in the form as a plain prefill;
  // the Guardrails are the User's own and stay as set.
  function showProposal(next: SurpriseProposal | null) {
    setProposal(next);
    if (!next) return;
    setFormHoldsProposal(true);
    toast.dismiss(START_KEY);
    setPrompt(next.edit.prompt);
    setDraft((current) => ({ ...current, ...surpriseFineTune(next.edit) }));
    setTargetDurationMinutes(next.edit.durationMinutes);
  }

  return (
    <section aria-labelledby="create-session-heading" data-testid="create-session">
      <h2 id="create-session-heading" className={cn(sectionHeadingClass, 'mt-6 mb-3')}>
        Start a New Session
      </h2>
      <DescribeSessionPanel
        prompt={prompt}
        onPromptChange={setPrompt}
        llmConfigured={llmConfigured}
        skipProfile={skipProfile}
        onSkipProfileChange={setSkipProfile}
        autoFocus={Boolean(initialPrompt)}
        action={
          surprise ? (
            <OnlineOnly>
              <SurpriseMe
                skipProfile={skipProfile}
                initialProposal={surprise.pending}
                starting={starting}
                onProposalChange={showProposal}
                onProposalReread={holdProposal}
                onStart={startFromModal}
              />
            </OnlineOnly>
          ) : null
        }
      />

      <SessionExtras
        coverStyle={coverStyle}
        onCoverStyleChange={setCoverStyle}
        useStandardCover={useStandardCover}
        onUseStandardCoverChange={setUseStandardCover}
        guardrails={draft.guardrails}
        onGuardrailsChange={(patch) =>
          setDraft((current) => ({ ...current, guardrails: { ...current.guardrails, ...patch } }))
        }
      >
        <DescribeFineTuneSection
          forYouGenres={forYouGenres}
          picks={draft}
          onPicksChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          ownVoiceOffer={ownVoiceOffer}
          className="border-b border-line"
        >
          <SessionDurationControl
            value={targetDurationMinutes}
            onChange={setTargetDurationMinutes}
            auto
          />
        </DescribeFineTuneSection>
      </SessionExtras>

      {/* The card commits from below the extras stack, so every pick a Session
          starts with sits above the button that sends it. */}
      <div className="mt-3">
        <OnlineOnly>
          <button
            type="button"
            data-testid="start-vibe"
            onClick={startSession}
            disabled={starting}
            className={cn(primaryButtonClass, 'w-full')}
          >
            {starting ? <LiedmotifLoader /> : null}
            {starting ? 'Starting…' : 'Start Session'}
          </button>
        </OnlineOnly>
      </div>
    </section>
  );
}
