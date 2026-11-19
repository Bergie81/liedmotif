'use client';

// The one cover editor for every cover a listener changes: a Session's and a
// Playlist's. A bottom sheet with a big stage showing the cover under
// consideration, the current cover inset in its corner for comparison, a strip
// with upload, the Playlist's mosaic and the cover history, and generation
// with the subject's own fields. Only "Use this cover" changes the cover: a
// finished attempt, an upload, an earlier cover and the mosaic all preview on
// the stage first. The subject (which routes, how a cover renders, which
// fields) comes from the caller; the preview rules live here once.

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import type {
  CoverStyleChoice,
  SessionCoverAttempt,
  SessionCoverHistoryEntry,
  SessionCoverUsage,
} from '@liedmotif/shared';
import { MAX_COVER_GUIDANCE_LENGTH } from '@liedmotif/shared';
import { Check, ImageUp, LayoutGrid, Sparkles, Trash2 } from 'lucide-react';
import type { ApiResult } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import { COVER_UPLOAD } from '@/lib/image-upload-targets';
import { coverSetupMessage } from '@/lib/cover-setup-copy';
import { pollWithBackoff } from '@/lib/poll-backoff';
import { useImageCropPicker } from '@/components/media/use-image-crop-picker';
import { useAppChrome } from '@/components/app-chrome-context';
import { coverUsageLine } from '@/components/player/cover-usage-line';
import { AlertBanner } from '@/components/ui/design-system';
import { Switch } from '@/components/ui/controls';
import { SheetContent, SheetHeader } from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';

const STATUS_POLL_MS = 3000;

type CoverKind = 'Session' | 'Playlist';

/** What both cover status routes answer. */
interface CoverStatusBase {
  coverImageId: string | null;
  generating: boolean;
  latestRegeneration: SessionCoverAttempt | null;
  usage: SessionCoverUsage;
  history: SessionCoverHistoryEntry[];
}

/** The subject's routes; a module constant, so its identity never changes. */
export interface CoverApi<S extends CoverStatusBase> {
  status: (subjectId: string, signal?: AbortSignal) => Promise<ApiResult<S>>;
  select: (subjectId: string, coverImageId: string) => Promise<ApiResult<unknown>>;
  /** Clear back to the derived mosaic; only a Playlist has one. */
  selectMosaic?: (subjectId: string) => Promise<ApiResult<unknown>>;
  upload: (subjectId: string, file: File) => Promise<ApiResult<{ coverImageId: string }>>;
  remove: (subjectId: string, coverImageId: string) => Promise<ApiResult<unknown>>;
}

/** What the owner tapped to preview: a history cover, or the derived mosaic. */
type Picked = { kind: 'cover'; coverImageId: string } | { kind: 'mosaic' };

/** The cover on the stage awaiting "Use this cover"; `target` null = the mosaic. */
type Candidate = { target: string | null; label: 'New' | 'Earlier' | 'Upload' | 'Mosaic' };

/** A pick wins over a finished attempt, but only while it would still change
 *  something: a non-current history entry, or the mosaic while a custom cover
 *  is set. */
function stageCandidate({
  picked,
  history,
  currentCoverImageId,
  hasMosaic,
  readyCoverId,
}: {
  picked: Picked | null;
  history: SessionCoverHistoryEntry[];
  currentCoverImageId: string | null;
  hasMosaic: boolean;
  readyCoverId: string | null;
}): Candidate | null {
  if (picked?.kind === 'mosaic') {
    if (hasMosaic && currentCoverImageId !== null) return { target: null, label: 'Mosaic' };
  } else if (picked) {
    const entry = history.find(
      (item) => item.coverImageId === picked.coverImageId && !item.isCurrent,
    );
    if (entry) {
      return {
        target: entry.coverImageId,
        label: entry.style === 'uploaded' ? 'Upload' : 'Earlier',
      };
    }
  }
  return readyCoverId ? { target: readyCoverId, label: 'New' } : null;
}

/** The plain-language reason generating is off, or null when it may run. */
function coverBlockedReason(
  kind: CoverKind,
  usage: SessionCoverUsage,
  viewerRole: 'admin' | 'member',
): string | null {
  if (!usage.providerConfigured) {
    if (!usage.sunoFallbackActive) return coverSetupMessage('provider_unconfigured', viewerRole);
    return viewerRole === 'admin'
      ? 'Covers come from Suno while no image provider is configured; Suno creates one cover per Session, so regenerating needs an image provider under Settings → Providers.'
      : 'Covers come from Suno while no image provider is set up; Suno creates one cover per Session, so regenerating needs the Admin to add an image provider.';
  }
  if (!usage.enabled) {
    if (kind === 'Playlist') return coverSetupMessage('generation_disabled', viewerRole);
    const consequence = usage.sunoFallbackActive
      ? 'Covers come from Suno — one cover per Session.'
      : 'Sessions wear the branded placeholder Cover.';
    return viewerRole === 'admin'
      ? `Tailored Cover Art is turned off under Settings → Generation, so ${consequence}`
      : `Tailored Cover Art is turned off on this server, so ${consequence} Ask the Admin to turn it on.`;
  }
  if (usage.remaining !== null && usage.remaining <= 0) {
    return usage.oneTime && usage.limitDay !== null && usage.usedDay >= usage.limitDay
      ? 'Your cover budget is used up. Ask the Admin for more.'
      : 'The cover generation limit is reached. It resets with the usage window.';
  }
  return null;
}

export function CoverSheetContent<S extends CoverStatusBase>({
  kind,
  title,
  subjectId,
  initialCoverImageId,
  maxHistory,
  api,
  renderCover,
  generate,
  renderFields,
  onCoverChanged,
  onClose,
}: {
  kind: CoverKind;
  title: string;
  subjectId: string;
  /** The caller's current cover, shown until the status answers. */
  initialCoverImageId: string | null;
  maxHistory: number;
  api: CoverApi<S>;
  /** One cover filling its box; null is the subject's look without a custom cover. */
  renderCover: (coverImageId: string | null, size: 'stage' | 'thumb') => ReactNode;
  /** Request one new attempt from the subject's current field values. */
  generate: (status: S) => Promise<ApiResult<{ coverGenerationId: string }>>;
  renderFields: (context: { status: S | null; disabled: boolean }) => ReactNode;
  onCoverChanged: (coverImageId: string | null) => void;
  onClose: () => void;
}) {
  const { viewerRole } = useAppChrome();
  const [status, setStatus] = useState<S | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A tapped cover or the mosaic, previewed on the stage until applied. */
  const [picked, setPicked] = useState<Picked | null>(null);
  /** The attempt this open started: only it previews by itself once ready. An
   *  unconfirmed attempt from an earlier open waits in the history instead. */
  const [requestedGenerationId, setRequestedGenerationId] = useState<string | null>(null);
  /** A ready attempt the owner turned down; it stays in the history. */
  const [dismissedCoverId, setDismissedCoverId] = useState<string | null>(null);
  /** The stage flipped to the current cover while a candidate is up. */
  const [peekCurrent, setPeekCurrent] = useState(false);

  /** Every cover action in the sheet, the upload included, shares one failure. */
  const failureKey = `${kind.toLowerCase()}-cover`;
  const reportFailure = useCallback(
    (message: string | null) => {
      if (message) toast.error(message, { key: failureKey });
      else toast.dismiss(failureKey);
    },
    [failureKey],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api.status(subjectId, signal);
      if (result.ok) {
        setStatus(result.data);
        setLoadError(null);
      } else if (!signal?.aborted) {
        // An aborted read is the sheet closing, not something to report.
        setLoadError(`Couldn’t load the cover status: ${result.error.message}`);
      }
      return result.ok;
    },
    [api, subjectId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // Poll only while an attempt is in flight, and only while the tab is visible.
  useEffect(() => {
    if (!status?.generating) return;
    return pollWithBackoff(STATUS_POLL_MS, refresh);
  }, [status?.generating, refresh]);

  /** Runs one action at a time; true when it landed. */
  async function run(action: () => Promise<ApiResult<unknown>>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    reportFailure(null);
    const result = await action();
    reportFailure(result.ok ? null : result.error.message);
    await refresh();
    setBusy(false);
    return result.ok;
  }

  // The upload keeps its own busy state in the crop dialog, so it does not ride
  // `run`: a failure must leave the dialog open with the framing intact.
  const picker = useImageCropPicker({
    target: COVER_UPLOAD,
    heading: `${kind} cover`,
    onError: reportFailure,
    onUpload: async (file) => {
      reportFailure(null);
      const result = await api.upload(subjectId, file);
      if (!result.ok) return result.error.message;
      await refresh();
      preview({ kind: 'cover', coverImageId: result.data.coverImageId });
      return null;
    },
  });

  /** Puts a pick on the stage; null hands the stage back to the current cover. */
  function preview(next: Picked | null) {
    setPicked(next);
    setPeekCurrent(false);
  }

  /** Back to the current cover; a fresh attempt turned down stays in the history. */
  function leavePreview() {
    if (candidate?.label === 'New') setDismissedCoverId(candidate.target);
    preview(null);
  }

  // The live status is authoritative once loaded; until then the caller's cover stands in.
  const currentCoverImageId = status ? status.coverImageId : initialCoverImageId;
  const history = status?.history ?? [];
  const latest = status?.latestRegeneration ?? null;
  const ownAttempt = latest && latest.coverGenerationId === requestedGenerationId ? latest : null;
  const readyCoverId =
    ownAttempt?.status === 'ready' &&
    ownAttempt.coverImageId !== currentCoverImageId &&
    ownAttempt.coverImageId !== dismissedCoverId &&
    history.some((entry) => entry.coverImageId === ownAttempt.coverImageId)
      ? ownAttempt.coverImageId
      : null;
  const attemptFailure =
    ownAttempt?.status === 'failed'
      ? (ownAttempt.failureMessageSafe ?? 'The cover could not be generated.')
      : null;
  const candidate = stageCandidate({
    picked,
    history,
    currentCoverImageId,
    hasMosaic: api.selectMosaic !== undefined,
    readyCoverId,
  });
  const stageShowsCandidate = candidate !== null && !peekCurrent;
  const mosaicPreviewed = candidate?.label === 'Mosaic';
  const working = busy || picker.busy;
  // Every cover takes one slot of the cap the routes enforce: uploads,
  // generated covers and the attempt still in flight. A full history blocks
  // uploading and generating alike.
  const keptCovers = status ? history.length + (status.generating ? 1 : 0) : 0;
  const historyFull = keptCovers >= maxHistory;
  const blockedReason = status ? coverBlockedReason(kind, status.usage, viewerRole) : null;
  const usageLine = status ? coverUsageLine(status.usage) : null;
  const fieldsDisabled = working || (status?.generating ?? false);
  const generateDisabled =
    working || !status || status.generating || historyFull || blockedReason !== null;

  // The stage keeps the chosen cover until the refreshed status names it
  // current, so the old cover never flashes in between. Any save settles a
  // finished attempt: it never previews by itself again and stays in the
  // history. An attempt still in flight is previewed once it lands.
  async function adopt(target: string | null) {
    const select = target === null ? api.selectMosaic : (id: string) => api.select(id, target);
    if (!select) return;
    const landed = await run(async () => {
      const result = await select(subjectId);
      if (result.ok) onCoverChanged(target);
      return result;
    });
    if (!landed) return;
    if (readyCoverId) setDismissedCoverId(readyCoverId);
    preview(null);
  }

  function startGeneration() {
    if (!status) return;
    void run(async () => {
      const result = await generate(status);
      if (result.ok) {
        preview(null);
        setRequestedGenerationId(result.data.coverGenerationId);
      }
      return result;
    });
  }

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="cover-sheet">
      <SheetHeader
        title={
          <>
            {kind} Cover: <span className="text-lamp">{title}</span>
          </>
        }
        closeLabel={`Close ${kind} Cover`}
        closeDisabled={working}
      />
      {loadError ? <AlertBanner className="mt-4">{loadError}</AlertBanner> : null}

      <div
        className="relative mx-auto mt-4 aspect-square w-full max-w-[400px] overflow-hidden rounded-[18px] bg-panel-2"
        data-testid="cover-stage"
        data-showing={stageShowsCandidate ? candidate.label.toLowerCase() : 'current'}
      >
        {renderCover(stageShowsCandidate ? candidate.target : currentCoverImageId, 'stage')}
        {status?.generating ? (
          <div
            className="absolute inset-0 z-[1] grid place-items-center bg-black/45 backdrop-blur-[2px]"
            role="status"
            aria-live="polite"
          >
            <span className="flex flex-col items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-paper">
              <LiedmotifLoader /> Generating…
            </span>
          </div>
        ) : null}
        {candidate ? (
          <button
            type="button"
            onClick={() => setPeekCurrent((value) => !value)}
            aria-label={
              peekCurrent ? 'Back to the previewed cover' : 'Compare with the current cover'
            }
            aria-pressed={peekCurrent}
            data-testid="cover-peek"
            className="absolute bottom-3 right-3 z-[2] h-[84px] w-[84px] overflow-hidden rounded-[12px] border-2 border-white/80 shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
          >
            {renderCover(peekCurrent ? candidate.target : currentCoverImageId, 'thumb')}
            <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.12em] text-paper">
              {peekCurrent ? candidate.label : 'Now'}
            </span>
          </button>
        ) : null}
      </div>

      {candidate ? (
        <div className="mx-auto mt-3 flex w-full max-w-[400px] gap-2">
          <button
            type="button"
            className={cn(primaryButtonClass, 'flex-1')}
            disabled={working}
            onClick={() => void adopt(candidate.target)}
            data-testid="cover-confirm"
          >
            <Check className="h-4 w-4" /> Use this cover
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={leavePreview}
            data-testid="cover-keep"
          >
            Keep current
          </button>
        </div>
      ) : null}

      <div className="mt-4">
        <h3 className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          <span>Previous covers · tap to preview</span>
          <span data-testid="cover-count" className={cn(historyFull && 'font-semibold text-warn')}>
            {keptCovers}/{maxHistory}
          </span>
        </h3>
        {/* The bleed padding keeps the selection rings from being clipped by
            the scroll container. */}
        <div
          className="-mx-1 mt-1 flex gap-2 overflow-x-auto px-1 pb-2 pt-1"
          data-testid="cover-history"
        >
          <button
            type="button"
            disabled={working || historyFull}
            onClick={picker.pick}
            aria-label="Upload image"
            data-testid="cover-upload"
            className={actionTileClass}
          >
            <span className="flex flex-col items-center gap-0.5 text-[9.5px] font-medium">
              <ImageUp className="h-5 w-5" aria-hidden /> Upload
            </span>
          </button>
          {api.selectMosaic && currentCoverImageId ? (
            <button
              type="button"
              disabled={working}
              onClick={() => preview(mosaicPreviewed ? null : { kind: 'mosaic' })}
              aria-label="Preview the Mosaic View made from the tracks' covers"
              title="Mosaic View, made from the tracks' covers"
              aria-pressed={mosaicPreviewed}
              data-testid="cover-mosaic"
              className={cn(actionTileClass, mosaicPreviewed && 'text-paper ring-2 ring-signal')}
            >
              <span className="flex flex-col items-center gap-0.5 text-center text-[9.5px] font-medium leading-tight">
                <LayoutGrid className="h-5 w-5" aria-hidden />
                <span>
                  Mosaic
                  <br />
                  View
                </span>
              </span>
            </button>
          ) : null}
          {history.map((entry) => {
            const isPreviewed = candidate !== null && entry.coverImageId === candidate.target;
            return (
              <div key={entry.coverImageId} className="relative h-16 w-16 flex-none">
                <button
                  type="button"
                  disabled={working}
                  aria-pressed={entry.isCurrent ? candidate === null : isPreviewed}
                  aria-label={
                    entry.isCurrent ? 'Show the current cover' : 'Preview this earlier cover'
                  }
                  onClick={() => {
                    if (entry.isCurrent || isPreviewed) leavePreview();
                    else preview({ kind: 'cover', coverImageId: entry.coverImageId });
                  }}
                  className={cn(
                    'absolute inset-0 overflow-hidden rounded-[10px] border border-line',
                    entry.isCurrent && 'ring-2 ring-lamp',
                    isPreviewed && 'ring-2 ring-signal',
                  )}
                >
                  {renderCover(entry.coverImageId, 'thumb')}
                </button>
                {!entry.isCurrent ? (
                  <button
                    type="button"
                    aria-label="Delete this cover"
                    disabled={working}
                    data-testid={`cover-history-delete-${entry.coverImageId}`}
                    onClick={() => void run(() => api.remove(subjectId, entry.coverImageId))}
                    className="absolute right-1 top-1 grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-ink/70 text-paper backdrop-blur-[4px] hover:text-warn disabled:opacity-45"
                  >
                    <Trash2 className="h-[12px] w-[12px]" aria-hidden />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {historyFull ? (
          <p className="mt-1 text-[12.5px] text-muted" data-testid="cover-history-full">
            This {kind} holds the maximum of {maxHistory} covers. Delete a previous cover to make
            room for a new one.
          </p>
        ) : null}
        {picker.element}
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          <span>Generate a new one</span>
          {usageLine ? (
            <span className="normal-case tracking-[0.04em] text-dim" data-testid="cover-usage">
              {usageLine}
            </span>
          ) : null}
        </h3>
        <div className="mt-2 flex flex-col gap-2">
          {renderFields({ status, disabled: fieldsDisabled })}
        </div>
        <button
          type="button"
          className={cn(primaryButtonClass, 'mt-3 w-full')}
          disabled={generateDisabled}
          data-testid="cover-generate"
          onClick={startGeneration}
        >
          {status?.generating ? (
            <>
              <LiedmotifLoader /> Generating…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> Generate
            </>
          )}
        </button>
        {blockedReason ? (
          <p className="mt-2 text-[12.5px] text-muted" data-testid="cover-blocked">
            {blockedReason}
          </p>
        ) : null}
        {attemptFailure ? (
          <AlertBanner className="mt-2" data-testid="cover-error">
            {attemptFailure}
          </AlertBanner>
        ) : null}
      </div>

      <div className="mt-5">
        <button
          type="button"
          className={cn(secondaryButtonClass, 'w-full')}
          disabled={working}
          onClick={onClose}
          data-testid="cover-close"
        >
          Close
        </button>
      </div>
    </SheetContent>
  );
}

const actionTileClass =
  'grid h-16 w-16 flex-none place-items-center rounded-[10px] border border-dashed border-line-2 text-muted transition-colors hover:border-lamp/60 hover:text-paper disabled:opacity-45';

/** The cover style pick, shared by both subjects' fields. */
export function CoverStyleField<T extends CoverStyleChoice>({
  choices,
  value,
  onChange,
  disabled,
  testId,
  note,
}: {
  choices: readonly T[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  testId: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass}>
        Cover style
        <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
          <SelectTrigger aria-label="Cover style" data-testid={testId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {COVER_STYLE_LABELS[choice]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {note ? <span className="text-[11.5px] leading-relaxed text-dim">{note}</span> : null}
    </div>
  );
}

/** The optional art direction: two lines, with the subject's own action and hint. */
export function ArtDirectionField({
  value,
  onChange,
  disabled,
  testId,
  action,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  testId: string;
  action?: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-semibold text-paper">
          Art direction
        </label>
        {action}
      </div>
      <textarea
        id={id}
        className={cn(inputClass, 'w-full resize-none')}
        rows={2}
        value={value}
        maxLength={MAX_COVER_GUIDANCE_LENGTH}
        placeholder="Optional art direction (e.g. sunset over vinyl)"
        aria-label="Cover art direction"
        data-testid={testId}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="text-[11.5px] leading-relaxed text-dim">{hint}</span> : null}
    </div>
  );
}

/** A per-attempt switch with its label and a line saying what it does. */
export function CoverToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  testId,
  hintTestId,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  testId: string;
  hintTestId?: string;
}) {
  return (
    <div className="mt-1 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-paper">{label}</div>
        <p className="mt-0.5 text-[11.5px] leading-[1.5] text-dim" data-testid={hintTestId}>
          {hint}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      />
    </div>
  );
}
