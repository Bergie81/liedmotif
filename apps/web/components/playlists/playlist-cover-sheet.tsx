'use client';

// Custom Playlist cover management (upload or generation through the same
// machinery as Session Covers). One bottom sheet: the current artwork (custom or
// the derived mosaic), upload, generation with optional art direction, the
// accumulating re-select history, and clear-back-to-mosaic. Generation never
// replaces the cover by itself — a ready attempt previews and the owner
// confirms, exactly like a Session Cover regeneration.

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import {
  COVER_STYLE_CHOICES,
  type CoverStyleChoice,
  type PlaylistSummaryItem,
} from '@liedmotif/shared';
import { Check, ImageUp, Sparkles, Trash2, X } from 'lucide-react';
import {
  deletePlaylistCover,
  playlistCoverStatus,
  regeneratePlaylistCover,
  selectPlaylistCover,
  uploadPlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import { useImageCropPicker } from '@/components/media/use-image-crop-picker';
import { COVER_UPLOAD } from '@/lib/image-upload-targets';
import { AlertBanner } from '@/components/ui/design-system';
import { Switch } from '@/components/ui/controls';
import { coverSetupMessage } from '@/lib/cover-setup-copy';
import { pollWithBackoff } from '@/lib/poll-backoff';
import { useAppChrome } from '@/components/app-chrome-context';
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
  /** A Playlist persists no style of its own, so every sheet opens on Auto. */
  const [styleChoice, setStyleChoice] = useState<CoverStyleChoice>('auto');
  const [guidance, setGuidance] = useState('');
  /** Per attempt, never persisted: every open starts without People. */
  const [usePeople, setUsePeople] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await playlistCoverStatus(playlist.id, signal);
      if (result.ok) setStatus(result.data);
      // An aborted read is the sheet closing, not something to report.
      else if (!signal?.aborted)
        setError(`Couldn’t load the cover status: ${result.error.message}`);
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
    setError(null);
    const result = await action();
    if (result && !result.ok && result.error) setError(result.error.message);
    await refresh();
    setBusy(false);
  }

  // The upload keeps its own busy/error state in the crop dialog, so it does not
  // ride `run` — a failure must leave the dialog open with the framing intact.
  const picker = useImageCropPicker({
    target: COVER_UPLOAD,
    heading: 'Playlist cover',
    onError: setError,
    onUpload: async (file) => {
      setError(null);
      const result = await uploadPlaylistCover(playlist.id, file);
      if (!result.ok) return result.error.message;
      onCoverChanged(result.data.coverImageId);
      await refresh();
      return null;
    },
  });

  async function adopt(coverImageId: string | null) {
    await run(async () => {
      const result = await selectPlaylistCover(playlist.id, coverImageId);
      if (result.ok) onCoverChanged(result.data.coverImageId);
      return result;
    });
  }

  // The live status is authoritative once loaded; until then the caller's summary stands in.
  const currentCoverImageId = status ? status.coverImageId : playlist.coverImageId;
  const readyAttempt =
    status?.latestRegeneration?.status === 'ready' ? status.latestRegeneration : null;
  const working = busy || picker.busy;
  const peopleAvailable = status?.peopleReferencesAvailable ?? false;
  const includePeople = usePeople && peopleAvailable;
  const generateDisabled =
    working ||
    !status ||
    status.generating ||
    !status.usage.providerConfigured ||
    !status.usage.enabled ||
    status.usage.remaining === 0;

  return (
    <SheetContent side="bottom" className="overflow-y-auto" data-testid="playlist-cover-sheet">
      <SheetHeader title="Playlist cover" closeDisabled={working} description={playlist.name} />
      {error ? <AlertBanner className="mt-4">{error}</AlertBanner> : null}

      <div className="mt-4 flex items-start gap-4">
        <PlaylistCover
          coverImageId={currentCoverImageId}
          mosaicCoverImageIds={playlist.mosaicCoverImageIds}
          className="h-[120px] w-[120px] flex-none rounded-[14px]"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={working}
            onClick={picker.pick}
            data-testid="playlist-cover-upload"
          >
            <ImageUp className="h-4 w-4" /> Upload image
          </button>
          {currentCoverImageId ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={working}
              onClick={() => void adopt(null)}
              data-testid="playlist-cover-clear"
            >
              <X className="h-4 w-4" /> Use the mosaic
            </button>
          ) : null}
          {picker.element}
        </div>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
          Generate a cover
        </h3>
        <Select
          value={styleChoice}
          onValueChange={(value) => setStyleChoice(value as CoverStyleChoice)}
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
            {COVER_STYLE_CHOICES.map((value) => (
              <SelectItem key={value} value={value}>
                {COVER_STYLE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          className={cn(inputClass, 'mt-2 w-full')}
          value={guidance}
          maxLength={300}
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
            void run(() =>
              regeneratePlaylistCover({
                playlistId: playlist.id,
                coverStyle: styleChoice,
                ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
                ...(includePeople ? { usePeopleReferences: true } : {}),
              }),
            )
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
        {readyAttempt ? (
          <div className="mt-3 flex items-center gap-3" data-testid="playlist-cover-preview">
            <span className="relative h-[72px] w-[72px] overflow-hidden rounded-[10px] bg-panel-2">
              <Image
                src={`/api/covers/${readyAttempt.coverImageId}`}
                alt="Freshly generated cover"
                fill
                className="object-cover"
              />
            </span>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={working}
              onClick={() => void adopt(readyAttempt.coverImageId)}
            >
              <Check className="h-4 w-4" /> Use this cover
            </button>
          </div>
        ) : null}
      </div>

      {status && status.history.length > 0 ? (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            Previous covers
          </h3>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {status.history.map((entry) => (
              <div key={entry.coverImageId} className="relative">
                <button
                  type="button"
                  disabled={working || entry.isCurrent}
                  onClick={() => void adopt(entry.coverImageId)}
                  aria-label={entry.isCurrent ? 'Current cover' : 'Use this previous cover'}
                  className={cn(
                    'relative block aspect-square w-full overflow-hidden rounded-[10px] border bg-panel-2',
                    entry.isCurrent ? 'border-lamp' : 'border-line hover:border-line-2',
                  )}
                >
                  <Image
                    src={`/api/covers/${entry.coverImageId}`}
                    alt=""
                    fill
                    className="object-cover"
                  />
                </button>
                {!entry.isCurrent ? (
                  <button
                    type="button"
                    aria-label="Delete this cover"
                    disabled={working}
                    onClick={() =>
                      void run(() => deletePlaylistCover(playlist.id, entry.coverImageId))
                    }
                    className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-[7px] bg-black/55 text-paper hover:text-warn"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <button
          type="button"
          className={cn(secondaryButtonClass, 'w-full')}
          disabled={working}
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </SheetContent>
  );
}
