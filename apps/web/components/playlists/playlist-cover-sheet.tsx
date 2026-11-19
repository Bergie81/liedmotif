'use client';

// Custom Playlist cover management (upload or generation through the same
// machinery as Session Covers). One bottom sheet: a big stage with the cover
// under consideration, the current artwork (custom or the derived mosaic) inset
// beside it for comparison, a strip with upload, the mosaic and the re-select
// history, and generation with optional art direction. Only "Use this cover"
// changes the Playlist's cover: a ready attempt, an upload, an earlier cover and
// the mosaic all preview on the stage first, exactly like a Session Cover.

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import {
  MAX_COVER_GUIDANCE_LENGTH,
  MAX_PLAYLIST_COVER_HISTORY,
  PLAYLIST_COVER_STYLE_CHOICES,
  type PlaylistCoverStyleChoice,
  type PlaylistSummaryItem,
} from '@liedmotif/shared';
import { Check, ImageUp, LayoutGrid, Sparkles, Trash2 } from 'lucide-react';
import {
  deletePlaylistCover,
  playlistCoverStatus,
  regeneratePlaylistCover,
  selectPlaylistCover,
  uploadPlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import { useImageCropPicker } from '@/components/media/use-image-crop-picker';
import { COVER_UPLOAD } from '@/lib/image-upload-targets';
import { AlertBanner } from '@/components/ui/design-system';
import { Switch } from '@/components/ui/controls';
import { coverSetupMessage } from '@/lib/cover-setup-copy';
import { pollWithBackoff } from '@/lib/poll-backoff';
import { useAppChrome } from '@/components/app-chrome-context';
import { coverArtSrc } from '@/components/player/player-presentation';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { PlaylistCover } from './playlist-cover';

const STATUS_POLL_MS = 2500;

/** What the owner tapped to preview: a history cover, or the derived mosaic. */
type Pick = { kind: 'cover'; coverImageId: string } | { kind: 'mosaic' };

/** The cover on the stage awaiting "Use this cover"; `target` null = the mosaic. */
type Candidate = { target: string | null; label: 'New' | 'Earlier' | 'Upload' | 'Mosaic' };

/** Every cover action in the sheet, the upload included, shares one failure. */
const COVER_KEY = 'playlist-cover';

function reportCoverFailure(message: string | null) {
  if (message) toast.error(message, { key: COVER_KEY });
  else toast.dismiss(COVER_KEY);
}

export function PlaylistCoverSheet({
  playlist,
  open,
  onClose,
  onCoverChanged,
}: {
  playlist: PlaylistSummaryItem;
  open: boolean;
  onClose: () => void;
  /** The playlist's custom-cover pointer changed (null = back to the mosaic). */
  onCoverChanged: (coverImageId: string | null) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <CoverSheetContent playlist={playlist} onClose={onClose} onCoverChanged={onCoverChanged} />
      ) : null}
    </Sheet>
  );
}

function CoverSheetContent({
  playlist,
  onClose,
  onCoverChanged,
}: {
  playlist: PlaylistSummaryItem;
  onClose: () => void;
  onCoverChanged: (coverImageId: string | null) => void;
}) {
  const { viewerRole } = useAppChrome();
  const [status, setStatus] = useState<PlaylistCoverStatusData | null>(null);
  /** A Playlist persists no style of its own, so every sheet opens on Random. */
  const [styleChoice, setStyleChoice] = useState<PlaylistCoverStyleChoice>('random');
  const [guidance, setGuidance] = useState('');
  /** Per attempt, never persisted: every open starts with People on, and it
   *  only takes effect when a Person could actually appear. */
  const [usePeople, setUsePeople] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A tapped cover or the mosaic, previewed on the stage until applied. */
  const [picked, setPicked] = useState<Pick | null>(null);
  /** The attempt this open started: only it previews by itself once ready. An
   *  unconfirmed attempt from an earlier open waits in the history instead. */
  const [requestedGenerationId, setRequestedGenerationId] = useState<string | null>(null);
  /** A ready attempt the owner turned down; it stays in the history. */
  const [dismissedCoverId, setDismissedCoverId] = useState<string | null>(null);
  /** The stage flipped to the current cover while a candidate is up. */
  const [peekCurrent, setPeekCurrent] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await playlistCoverStatus(playlist.id, signal);
      if (result.ok) {
        setStatus(result.data);
        setLoadError(null);
      }
      // An aborted read is the sheet closing, not something to report.
      else if (!signal?.aborted)
        setLoadError(`Couldn’t load the cover status: ${result.error.message}`);
      return result.ok;
    },
    [playlist.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // Poll only while an attempt is in flight, and only while the tab is
  // visible; the sheet is short-lived.
  useEffect(() => {
    if (!status?.generating) return;
    return pollWithBackoff(STATUS_POLL_MS, refresh);
  }, [status?.generating, refresh]);

  async function run(action: () => Promise<{ ok: boolean; error?: { message: string } } | void>) {
    if (busy) return;
    setBusy(true);
    reportCoverFailure(null);
    const result = await action();
    if (result) reportCoverFailure(!result.ok && result.error ? result.error.message : null);
    await refresh();
    setBusy(false);
  }

  // The upload keeps its own busy state in the crop dialog, so it does not ride
  // `run` — a failure must leave the dialog open with the framing intact.
  const picker = useImageCropPicker({
    target: COVER_UPLOAD,
    heading: 'Playlist cover',
    onError: reportCoverFailure,
    onUpload: async (file) => {
      reportCoverFailure(null);
      const result = await uploadPlaylistCover(playlist.id, file);
      if (!result.ok) return result.error.message;
      await refresh();
      setPeekCurrent(false);
      setPicked({ kind: 'cover', coverImageId: result.data.coverImageId });
      return null;
    },
  });

  function endPreview() {
    setPicked(null);
    setPeekCurrent(false);
  }

  // The stage keeps the chosen cover until the refreshed status names it
  // current, so the old cover never flashes in between.
  async function adopt(coverImageId: string | null) {
    await run(async () => {
      const result = await selectPlaylistCover(playlist.id, coverImageId);
      if (result.ok) onCoverChanged(result.data.coverImageId);
      return result;
    });
    endPreview();
  }

  // The live status is authoritative once loaded; until then the caller's summary stands in.
  const currentCoverImageId = status ? status.coverImageId : playlist.coverImageId;
  const readyCoverId =
    status?.latestRegeneration?.status === 'ready' &&
    status.latestRegeneration.coverGenerationId === requestedGenerationId &&
    status.latestRegeneration.coverImageId !== currentCoverImageId &&
    status.latestRegeneration.coverImageId !== dismissedCoverId
      ? status.latestRegeneration.coverImageId
      : null;
  // A pick survives only while it would still change something: a non-current
  // history entry, or the mosaic while a custom cover is set.
  const pickedEntry =
    picked?.kind === 'cover'
      ? status?.history.find(
          (entry) => entry.coverImageId === picked.coverImageId && !entry.isCurrent,
        )
      : undefined;
  const candidate: Candidate | null =
    picked?.kind === 'mosaic' && currentCoverImageId !== null
      ? { target: null, label: 'Mosaic' }
      : pickedEntry
        ? {
            target: pickedEntry.coverImageId,
            label: pickedEntry.style === 'uploaded' ? 'Upload' : 'Earlier',
          }
        : readyCoverId
          ? { target: readyCoverId, label: 'New' }
          : null;
  const stageShowsCandidate = candidate !== null && !peekCurrent;
  const working = busy || picker.busy;
  const peopleAvailable = status?.peopleReferencesAvailable ?? false;
  const includePeople = usePeople && peopleAvailable;
  // Every cover counts against the cap the routes enforce: uploads, generated
  // covers, and the attempt still in flight.
  const keptCovers = status ? status.history.length + (status.generating ? 1 : 0) : 0;
  const historyFull = keptCovers >= MAX_PLAYLIST_COVER_HISTORY;
  const generateDisabled =
    working ||
    historyFull ||
    !status ||
    status.generating ||
    !status.usage.providerConfigured ||
    !status.usage.enabled ||
    status.usage.remaining === 0;

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="playlist-cover-sheet">
      <SheetHeader title="Playlist cover" closeDisabled={working} description={playlist.name} />
      {loadError ? <AlertBanner className="mt-4">{loadError}</AlertBanner> : null}

      <div
        className="relative mx-auto mt-4 aspect-square w-full max-w-[400px] overflow-hidden rounded-[18px] bg-panel-2"
        data-testid="playlist-cover-stage"
        data-showing={stageShowsCandidate ? candidate.label.toLowerCase() : 'current'}
      >
        <PlaylistCover
          coverImageId={stageShowsCandidate ? candidate.target : currentCoverImageId}
          mosaicCoverImageIds={playlist.mosaicCoverImageIds}
          className="h-full w-full"
        />
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
            aria-label={peekCurrent ? 'Show the previewed cover' : 'Show the current cover'}
            aria-pressed={peekCurrent}
            data-testid="playlist-cover-peek"
            className="absolute bottom-3 right-3 z-[2] h-[84px] w-[84px] overflow-hidden rounded-[12px] border-2 border-white/80 shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
          >
            <PlaylistCover
              coverImageId={peekCurrent ? candidate.target : currentCoverImageId}
              mosaicCoverImageIds={playlist.mosaicCoverImageIds}
              className="h-full w-full"
            />
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
            data-testid="playlist-cover-confirm"
          >
            <Check className="h-4 w-4" /> Use this cover
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              if (candidate.label === 'New') setDismissedCoverId(candidate.target);
              endPreview();
            }}
            data-testid="playlist-cover-keep"
          >
            Keep current
          </button>
        </div>
      ) : null}

      <div className="mt-4">
        <h3 className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          <span>Previous covers · tap to preview</span>
          <span
            data-testid="playlist-cover-count"
            className={cn(historyFull && 'font-semibold text-warn')}
          >
            {keptCovers}/{MAX_PLAYLIST_COVER_HISTORY}
          </span>
        </h3>
        {/* The bleed padding keeps the selection rings from being clipped by
            the scroll container. */}
        <div className="-mx-1 mt-1 flex gap-2 overflow-x-auto px-1 pb-2 pt-1">
          <button
            type="button"
            disabled={working || historyFull}
            onClick={picker.pick}
            aria-label="Upload image"
            data-testid="playlist-cover-upload"
            className="grid h-16 w-16 flex-none place-items-center rounded-[10px] border border-dashed border-line-2 text-muted transition-colors hover:border-lamp/60 hover:text-paper disabled:opacity-45"
          >
            <span className="flex flex-col items-center gap-0.5 text-[9.5px] font-medium">
              <ImageUp className="h-5 w-5" aria-hidden /> Upload
            </span>
          </button>
          {currentCoverImageId ? (
            <button
              type="button"
              disabled={working}
              onClick={() => {
                setPeekCurrent(false);
                setPicked(candidate?.label === 'Mosaic' ? null : { kind: 'mosaic' });
              }}
              aria-label="Preview the Mosaic View made from the tracks' covers"
              title="Mosaic View, made from the tracks' covers"
              aria-pressed={candidate?.label === 'Mosaic'}
              data-testid="playlist-cover-clear"
              className={cn(
                'grid h-16 w-16 flex-none place-items-center rounded-[10px] border border-dashed border-line-2 text-muted transition-colors hover:border-lamp/60 hover:text-paper disabled:opacity-45',
                candidate?.label === 'Mosaic' && 'text-paper ring-2 ring-signal',
              )}
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
          {(status?.history ?? []).map((entry) => {
            const isPreviewed = candidate !== null && entry.coverImageId === candidate.target;
            return (
              <div key={entry.coverImageId} className="relative h-16 w-16 flex-none">
                <button
                  type="button"
                  disabled={working}
                  aria-pressed={entry.isCurrent ? candidate === null : isPreviewed}
                  aria-label={
                    entry.isCurrent ? 'Show the current cover' : 'Preview this previous cover'
                  }
                  onClick={() => {
                    setPeekCurrent(false);
                    if (entry.isCurrent || isPreviewed) {
                      // Back to the current cover; a fresh attempt stays in the
                      // history, one tap away.
                      if (isPreviewed && candidate.label === 'New')
                        setDismissedCoverId(entry.coverImageId);
                      setPicked(null);
                    } else {
                      setPicked({ kind: 'cover', coverImageId: entry.coverImageId });
                    }
                  }}
                  className={cn(
                    'absolute inset-0 overflow-hidden rounded-[10px] border border-line',
                    entry.isCurrent && 'ring-2 ring-lamp',
                    isPreviewed && 'ring-2 ring-signal',
                  )}
                >
                  <CoverImage coverImageId={entry.coverImageId} thumb />
                </button>
                {!entry.isCurrent ? (
                  <button
                    type="button"
                    aria-label="Delete this cover"
                    disabled={working}
                    onClick={() =>
                      void run(() => deletePlaylistCover(playlist.id, entry.coverImageId))
                    }
                    className="absolute right-1 top-1 grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-ink/70 text-paper backdrop-blur-[4px] hover:text-warn disabled:opacity-45"
                  >
                    <Trash2 className="h-[12px] w-[12px]" aria-hidden />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {picker.element}
        {historyFull ? (
          <p className="mt-1 text-[12.5px] text-muted" data-testid="playlist-cover-full">
            This Playlist holds the maximum of {MAX_PLAYLIST_COVER_HISTORY} covers. Delete a
            previous cover to make room for a new one.
          </p>
        ) : null}
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          Generate a new one
        </h3>
        <Select
          value={styleChoice}
          onValueChange={(value) => setStyleChoice(value as PlaylistCoverStyleChoice)}
          disabled={working || status?.generating}
        >
          <SelectTrigger
            aria-label="Cover style"
            data-testid="playlist-cover-style"
            className="mt-2 w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAYLIST_COVER_STYLE_CHOICES.map((value) => (
              <SelectItem key={value} value={value}>
                {COVER_STYLE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <textarea
          className={cn(inputClass, 'mt-2 w-full resize-none')}
          rows={2}
          value={guidance}
          maxLength={MAX_COVER_GUIDANCE_LENGTH}
          placeholder="Optional art direction (e.g. sunset over vinyl)"
          aria-label="Cover art direction"
          disabled={working || status?.generating}
          onChange={(event) => setGuidance(event.target.value)}
        />
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-paper">Use People reference photos</div>
            <p className="mt-1 text-[11.5px] leading-[1.5] text-dim">
              {peopleAvailable
                ? 'Draws the People named in this Playlist’s name or art direction — you when nobody is named.'
                : 'Needs a Person with a reference photo under Settings → People, with cover references not set to Never.'}
            </p>
          </div>
          <Switch
            checked={includePeople}
            onCheckedChange={setUsePeople}
            disabled={working || status?.generating || !peopleAvailable}
            aria-label="Use People reference photos"
            data-testid="playlist-cover-use-people"
          />
        </div>
        <button
          type="button"
          className={cn(primaryButtonClass, 'mt-2 w-full')}
          disabled={generateDisabled}
          data-testid="playlist-cover-generate"
          onClick={() =>
            void run(async () => {
              const result = await regeneratePlaylistCover({
                playlistId: playlist.id,
                coverStyle: styleChoice,
                ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                ...(includePeople ? { usePeopleReferences: true } : {}),
              });
              if (result.ok) {
                endPreview();
                setRequestedGenerationId(result.data.coverGenerationId);
              }
              return result;
            })
          }
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
        {status && !status.usage.providerConfigured ? (
          <p className="mt-2 text-[12.5px] text-muted">
            {coverSetupMessage('provider_unconfigured', viewerRole)}
          </p>
        ) : null}
        {status && status.usage.providerConfigured && status.usage.remaining === 0 ? (
          <p className="mt-2 text-[12.5px] text-muted">
            The cover generation budget for this window is used up.
          </p>
        ) : null}
        {status?.latestRegeneration?.status === 'failed' ? (
          <p className="mt-2 text-[12.5px] text-warn" role="status">
            {status.latestRegeneration.failureMessageSafe ??
              'The last generation failed — the current cover is unchanged.'}
          </p>
        ) : null}
      </div>

      <div className="mt-5">
        <button
          type="button"
          className={cn(secondaryButtonClass, 'w-full')}
          disabled={working}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </SheetContent>
  );
}

function CoverImage({ coverImageId, thumb = false }: { coverImageId: string; thumb?: boolean }) {
  return (
    <span className="absolute inset-0 block bg-panel-2">
      <Image
        src={coverArtSrc(coverImageId, thumb ? 'thumb' : 'full')}
        alt=""
        fill
        className="object-cover"
      />
    </span>
  );
}
