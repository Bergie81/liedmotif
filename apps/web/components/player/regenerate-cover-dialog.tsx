'use client';

// Reroll Cover Art modal, opened from the
// player's Session options sheet and from a My Sessions card's options. Shows the Session's current cover with its
// generated history beneath, requests exactly one new paid attempt per reroll,
// and polls the cover status while open. Nothing is ever applied on its own: a
// finished attempt and any tapped history entry are PREVIEWED as a candidate,
// and the session keeps its cover until the user saves the swap (or cancels —
// a generated cover stays in the history either way). History entries can be
// deleted; the current cover is never deletable. A session keeps at most
// MAX_SESSION_COVER_HISTORY generated covers — at the cap, rerolling stays
// blocked until one is deleted.

import { useCallback, useEffect, useId, useState } from 'react';
import { Check, ImagePlus, ImageUp, Trash2 } from 'lucide-react';
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import {
  COVER_STYLE_CHOICES,
  MAX_COVER_GUIDANCE_LENGTH,
  MAX_SESSION_COVER_HISTORY,
  type CoverStyleChoice,
  type SessionCoverUsage,
} from '@liedmotif/shared';
import { FoldSection } from '@/components/create/session-start-controls';
import { Switch } from '@/components/ui/controls';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  deleteSessionCover,
  getSessionCoverStatus,
  regenerateSessionCover,
  selectSessionCover,
  uploadSessionCover,
  type SessionCoverStatusData,
} from '@/lib/api-client';
import { useImageCropPicker } from '@/components/media/use-image-crop-picker';
import { cn } from '@/lib/cn';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import { COVER_UPLOAD } from '@/lib/image-upload-targets';
import { coverSetupMessage } from '@/lib/cover-setup-copy';
import { pollWithBackoff } from '@/lib/poll-backoff';
import { useAppChrome } from '@/components/app-chrome-context';
import { AlertBanner } from '@/components/ui/design-system';
import { LiedmotifLoader } from '@/components/ui/loading';
import { ScrambleText } from './scramble-text';
import { CoverArt, CoverFallback } from './cover-art';
import { CoverChip } from './cover-chip';

const STATUS_POLL_MS = 3000;

/**
 * The plain-language reason rerolling is disabled, or null when it may run.
 * `historyFull` blocks uploading too — every cover the Session keeps occupies
 * the same slot, whoever made it.
 */
function regenerateBlockedReason(
  usage: SessionCoverUsage,
  historyFull: boolean,
  viewerRole: 'admin' | 'member',
): string | null {
  if (!usage.providerConfigured) {
    if (!usage.sunoFallbackActive) return coverSetupMessage('provider_unconfigured', viewerRole);
    return viewerRole === 'admin'
      ? 'Covers come from Suno while no image provider is configured; Suno creates one cover per Session, so regenerating needs an image provider under Settings → Providers.'
      : 'Covers come from Suno while no image provider is set up; Suno creates one cover per Session, so regenerating needs the Admin to add an image provider.';
  }
  if (!usage.enabled) {
    const consequence = usage.sunoFallbackActive
      ? 'Covers come from Suno — one cover per Session.'
      : 'Sessions wear the branded placeholder Cover.';
    return viewerRole === 'admin'
      ? `Tailored Cover Art is turned off under Settings → Generation, so ${consequence}`
      : `Tailored Cover Art is turned off on this server, so ${consequence} Ask the Admin to turn it on.`;
  }
  if (historyFull) {
    return `This Session holds the maximum of ${MAX_SESSION_COVER_HISTORY} covers. Delete a previous cover to make room for a new one.`;
  }
  if (usage.remaining !== null && usage.remaining <= 0) {
    return usage.oneTime && usage.limitDay !== null && usage.usedDay >= usage.limitDay
      ? 'Your cover budget is used up. Ask the Admin for more.'
      : 'The cover generation limit is reached. It resets with the usage window.';
  }
  return null;
}

/** Show the month counter only when the month window is the binding budget. */
function monthWindowBinds(usage: SessionCoverUsage): boolean {
  if (usage.limitMonth === null || usage.limitDay === null) return false;
  return usage.limitMonth - usage.usedMonth < usage.limitDay - usage.usedDay;
}

export function RegenerateCoverDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
  coverImageId,
  onCoverChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sessionTitle: string;
  /** The caller's current cover — shown until the first status poll answers. */
  coverImageId: string | null;
  /** A saved swap, so a caller that renders the cover itself can follow it. */
  onCoverChanged?: (coverImageId: string) => void;
}) {
  const { viewerRole } = useAppChrome();
  const [status, setStatus] = useState<SessionCoverStatusData | null>(null);
  /** The attempt THIS modal started — only its outcome is surfaced. */
  const [requestedId, setRequestedId] = useState<string | null>(null);
  /** The user declined the finished attempt; it stays in history only. */
  const [dismissed, setDismissed] = useState(false);
  /** A tapped history entry, previewed as the candidate until saved. */
  const [selectedCoverId, setSelectedCoverId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  /** null = untouched — the select then mirrors the session's stored style. */
  const [styleChoice, setStyleChoice] = useState<CoverStyleChoice | null>(null);
  const [guidance, setGuidance] = useState('');
  const guidanceId = useId();
  /** null = untouched — the switch then mirrors the global setting. */
  const [enhanceChoice, setEnhanceChoice] = useState<boolean | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await getSessionCoverStatus(sessionId, signal);
      if (result.ok) setStatus(result.data);
      return result.ok;
    },
    [sessionId],
  );

  // One-shot on open: reset the modal state and load the current status, so
  // opening with nothing in flight still shows fresh numbers.
  useEffect(() => {
    if (!open) return;
    setRequestedId(null);
    setDismissed(false);
    setSelectedCoverId(null);
    setSubmitError(null);
    setStyleChoice(null);
    setGuidance('');
    setEnhanceChoice(null);
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh]);

  // Poll only while an attempt is in flight, and only while the tab is
  // visible — an idle open dialog (or a background tab) costs nothing.
  useEffect(() => {
    if (!open || !status?.generating) return;
    return pollWithBackoff(STATUS_POLL_MS, refresh);
  }, [open, status?.generating, refresh]);

  // An uploaded cover joins the same history as a rerolled one and follows the
  // same save-to-apply model: it lands as the previewed candidate, and the
  // Session keeps its cover until the owner saves the swap.
  const picker = useImageCropPicker({
    target: COVER_UPLOAD,
    heading: 'Session cover',
    confirmLabel: 'Use this cover',
    onError: setSubmitError,
    onUpload: async (file) => {
      setSubmitError(null);
      const result = await uploadSessionCover(sessionId, file);
      if (!result.ok) return result.error.message;
      await refresh();
      setDismissed(true);
      setSelectedCoverId(result.data.coverImageId);
      return null;
    },
  });

  const generating = status?.generating ?? false;
  const requestedAttempt =
    status?.latestRegeneration?.coverGenerationId === requestedId
      ? status?.latestRegeneration
      : null;
  const attemptFailure = requestedAttempt?.failureMessageSafe ?? null;
  /** A finished, unconfirmed attempt: previewed big, applied only on save. */
  const pendingCoverId =
    !dismissed &&
    requestedAttempt?.status === 'ready' &&
    requestedAttempt.coverImageId !== status?.coverImageId
      ? requestedAttempt.coverImageId
      : null;
  const currentCoverId = status ? status.coverImageId : coverImageId;
  const history = status?.history ?? [];
  /** An explicit history pick wins over the fresh attempt; both only preview.
   * A pick is dropped once it is no longer selectable (deleted, or current). */
  const pickedCoverId =
    selectedCoverId !== null &&
    selectedCoverId !== currentCoverId &&
    history.some((entry) => entry.coverImageId === selectedCoverId)
      ? selectedCoverId
      : null;
  const candidateCoverId = pickedCoverId ?? pendingCoverId;
  const shownCoverId = candidateCoverId ?? currentCoverId;
  const errorMessage = submitError ?? attemptFailure ?? null;
  const usage = status?.usage ?? null;
  const historyFull = history.length >= MAX_SESSION_COVER_HISTORY;
  const blockedReason = usage ? regenerateBlockedReason(usage, historyFull, viewerRole) : null;
  const llmConfigured = status?.promptEnhancement.llmConfigured ?? false;
  const enhanceActive = enhanceChoice ?? status?.promptEnhancement.active ?? false;

  async function start() {
    setBusy(true);
    setSubmitError(null);
    setDismissed(false);
    setSelectedCoverId(null);
    const result = await regenerateSessionCover(sessionId, {
      ...(styleChoice ? { coverStyle: styleChoice } : {}),
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      // A flipped switch overrides the global setting for this attempt only.
      ...(enhanceChoice === null ? {} : { enhance: enhanceChoice }),
    });
    setBusy(false);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    setRequestedId(result.data.coverGenerationId);
    void refresh();
  }

  async function applyCover(historyCoverImageId: string) {
    if (historyBusyId) return;
    setHistoryBusyId(historyCoverImageId);
    setSubmitError(null);
    const result = await selectSessionCover(sessionId, historyCoverImageId);
    setHistoryBusyId(null);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    if (historyCoverImageId === pendingCoverId) setRequestedId(null);
    setSelectedCoverId(null);
    onCoverChanged?.(historyCoverImageId);
    void refresh();
  }

  async function deleteFromHistory(historyCoverImageId: string) {
    if (historyBusyId) return;
    setHistoryBusyId(historyCoverImageId);
    setSubmitError(null);
    const result = await deleteSessionCover(sessionId, historyCoverImageId);
    setHistoryBusyId(null);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    if (historyCoverImageId === pendingCoverId) setRequestedId(null);
    if (historyCoverImageId === selectedCoverId) setSelectedCoverId(null);
    void refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="regenerate-cover-dialog"
        aria-describedby={undefined}
        className="max-h-[85vh] overflow-y-auto desk:max-w-[880px]"
      >
        <DialogCloseButton data-testid="regenerate-cover-close" />

        <div className="px-8 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-lamp">
            Reroll Cover Art
          </p>
          <DialogTitle className="mt-1 truncate font-display text-[22px] font-extrabold leading-[1.2] tracking-[-0.02em] text-paper">
            {sessionTitle}
          </DialogTitle>
        </div>

        <div className="mt-6 desk:grid desk:grid-cols-[320px_minmax(0,1fr)] desk:items-start desk:gap-8">
          <div>
            <div className="relative mx-auto aspect-square w-full max-w-[280px] overflow-hidden rounded-[16px] bg-panel-2 desk:max-w-none">
              <CoverArt
                coverImageId={shownCoverId}
                className="h-full w-full object-cover"
                fallback={<CoverFallback iconClassName="h-14 w-14" />}
              />
              <div className="absolute left-3 top-3 z-[1]">
                {generating ? (
                  <CoverChip role="status" aria-live="polite" data-testid="cover-generating-chip">
                    <ScrambleText text="Generating cover…" />
                  </CoverChip>
                ) : null}
              </div>
            </div>

            {history.length > 0 ? (
              <div
                className="mx-auto mt-4 max-w-[280px] desk:max-w-[320px]"
                data-testid="cover-history"
              >
                <p className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-dim">
                  <span>Previous covers · tap to preview</span>
                  <span
                    data-testid="cover-history-count"
                    className={cn(
                      history.length >= MAX_SESSION_COVER_HISTORY && 'font-semibold text-warn',
                    )}
                  >
                    {history.length}/{MAX_SESSION_COVER_HISTORY}
                  </span>
                </p>
                {/* Sized so a half tile peeks past the fold — the scroll cue.
                    The bleed padding keeps the selection rings from being
                    clipped by the scroll container. */}
                <div className="-mx-1 mt-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2 pt-1">
                  {history.map((entry) => {
                    const isPicked = entry.coverImageId === pickedCoverId;
                    return (
                      <div
                        key={entry.coverImageId}
                        className="relative h-16 w-16 flex-none snap-start"
                      >
                        <button
                          type="button"
                          disabled={historyBusyId !== null}
                          aria-pressed={entry.isCurrent ? pickedCoverId === null : isPicked}
                          aria-label={
                            entry.isCurrent
                              ? 'Show the current cover'
                              : `Preview this earlier ${entry.style.replace('_', ' ')} cover`
                          }
                          onClick={() =>
                            setSelectedCoverId(
                              entry.isCurrent || isPicked ? null : entry.coverImageId,
                            )
                          }
                          className={cn(
                            'absolute inset-0 overflow-hidden rounded-[10px] border border-line transition-opacity',
                            entry.isCurrent
                              ? 'ring-2 ring-lamp'
                              : isPicked
                                ? 'ring-2 ring-signal'
                                : 'disabled:opacity-45 motion-safe:hover:opacity-80',
                          )}
                        >
                          <CoverArt
                            coverImageId={entry.coverImageId}
                            className="h-full w-full object-cover"
                            fallback={<CoverFallback iconClassName="h-6 w-6" />}
                          />
                        </button>
                        {!entry.isCurrent ? (
                          <button
                            type="button"
                            disabled={historyBusyId !== null}
                            aria-label="Delete this cover from the history"
                            data-testid={`cover-history-delete-${entry.coverImageId}`}
                            onClick={() => void deleteFromHistory(entry.coverImageId)}
                            className="absolute right-1 top-1 grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-ink/70 text-paper backdrop-blur-[4px] hover:text-warn disabled:opacity-45"
                          >
                            <Trash2 className="h-[12px] w-[12px]" aria-hidden />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {candidateCoverId ? (
              <div className="mx-auto mt-2 flex w-full max-w-[280px] items-stretch gap-2 desk:max-w-[320px]">
                <button
                  type="button"
                  data-testid="regenerate-cover-confirm"
                  disabled={historyBusyId !== null}
                  onClick={() => void applyCover(candidateCoverId)}
                  className={cn(primaryButtonClass, 'flex-1')}
                >
                  <Check className="h-4 w-4" aria-hidden />
                  {historyBusyId === candidateCoverId ? 'Saving…' : 'Save Cover Art'}
                </button>
                <button
                  type="button"
                  data-testid="regenerate-cover-dismiss"
                  onClick={() => {
                    setDismissed(true);
                    setSelectedCoverId(null);
                  }}
                  className={secondaryButtonClass}
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex flex-col gap-2 desk:mt-0">
            {/* A bare count with no ceiling tells the user nothing actionable. */}
            {usage && (usage.oneTime || usage.limitDay !== null) ? (
              <p
                data-testid="cover-usage-indicator"
                className="text-center font-mono text-[10px] uppercase tracking-[0.08em] text-dim desk:text-left"
              >
                {usage.oneTime ? (
                  `Covers: ${usage.usedDay} of ${usage.limitDay} in total`
                ) : (
                  <>
                    Covers today: {usage.usedDay} of {usage.limitDay}
                    {monthWindowBinds(usage) ? (
                      <>
                        {' '}
                        · This month: {usage.usedMonth} of {usage.limitMonth}
                      </>
                    ) : null}
                  </>
                )}
              </p>
            ) : null}

            <FoldSection
              title="Advanced"
              embedded
              defaultOpen
              className="rounded-[12px] border border-line [&>div]:px-3 [&>summary]:p-3"
            >
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-2 text-[13px] font-semibold text-paper">
                  Cover style
                  <Select
                    value={styleChoice ?? status?.coverStyle ?? 'auto'}
                    onValueChange={(value) => setStyleChoice(value as CoverStyleChoice)}
                  >
                    <SelectTrigger
                      aria-label="Cover style"
                      data-testid="regenerate-cover-style"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COVER_STYLE_CHOICES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {COVER_STYLE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[11.5px] font-normal leading-relaxed text-dim">
                    A changed style becomes this Session’s style going forward.
                  </span>
                </label>
                <div className="flex flex-col gap-2 text-[13px] font-semibold text-paper">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor={guidanceId}>Art direction</label>
                    {status?.sessionPrompt ? (
                      <button
                        type="button"
                        data-testid="use-session-prompt"
                        onClick={() => setGuidance(status.sessionPrompt ?? '')}
                        className="rounded-full border border-line px-3 py-1.5 text-[11.5px] font-medium text-muted transition-colors duration-[120ms] hover:border-lamp/50 hover:text-paper"
                      >
                        Use session prompt
                      </button>
                    ) : null}
                  </div>
                  <textarea
                    id={guidanceId}
                    value={guidance}
                    onChange={(event) => setGuidance(event.target.value)}
                    maxLength={MAX_COVER_GUIDANCE_LENGTH}
                    rows={2}
                    placeholder="Optional message steering this cover — mood, scene, colors…"
                    data-testid="regenerate-cover-guidance"
                    className={cn(inputClass, 'resize-y text-[13.5px] font-normal')}
                  />
                  {llmConfigured ? (
                    <span className="mt-2 flex items-center gap-3">
                      <Switch
                        checked={enhanceActive}
                        onCheckedChange={setEnhanceChoice}
                        aria-label="Enhance prompt with the Writing AI"
                        data-testid="regenerate-enhance-toggle"
                      />
                      <span
                        data-testid="enhancement-note"
                        className="text-[11px] font-normal leading-relaxed text-dim"
                      >
                        {enhanceActive
                          ? 'Optimized automatically by your Writing AI.'
                          : 'Sent to the image model exactly as written.'}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
            </FoldSection>

            <button
              type="button"
              data-testid="regenerate-cover-start"
              disabled={busy || generating || blockedReason !== null}
              onClick={() => void start()}
              className={cn(primaryButtonClass, 'mt-1')}
            >
              {busy || generating ? (
                <>
                  <LiedmotifLoader /> Generating Cover…
                </>
              ) : (
                <>
                  <ImagePlus className="h-4 w-4" aria-hidden /> Reroll Cover Art
                </>
              )}
            </button>
            {/* Uploading costs nothing and needs no provider, so it stays
                available whenever the history has room. */}
            <button
              type="button"
              data-testid="upload-cover-start"
              disabled={picker.busy || historyFull}
              onClick={picker.pick}
              className={secondaryButtonClass}
            >
              <ImageUp className="h-4 w-4" aria-hidden />
              {picker.busy ? 'Uploading…' : 'Upload your own'}
            </button>
            {picker.element}
            {blockedReason ? (
              <p
                data-testid="regenerate-cover-blocked"
                className="text-center text-[12px] text-dim desk:text-left"
              >
                {blockedReason}
              </p>
            ) : null}
            {errorMessage ? (
              <AlertBanner data-testid="regenerate-cover-error">{errorMessage}</AlertBanner>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
