'use client';

// The now-playing generation-controller banner, and the one action it
// can offer.
//
// Renders WHY generation is degraded — cost-limit Session Repeat, provider
// blocks, worker stalls — straight from `generationStatus` + the server's safe
// message, against what the Session actually has to play. The session lifecycle
// stays `active` throughout; `ok` renders nothing. The copy/tone come
// from the pure, unit-tested `presentGenerationStatus` mapping in
// @liedmotif/shared.
//
// A Session blocked before its first Track can never recover on its own, so the
// banner takes an action slot for the way out. The slot keeps the banner itself
// free of Session wiring: only a surface that owns the Session can fill it, so
// a banner rendered for some OTHER Session cannot offer a way out of this one.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AlertTriangle, Info, Loader2, Repeat, Trash2 } from 'lucide-react';
import { presentGenerationStatus } from '@liedmotif/shared';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { compactDangerButtonClass } from '@/components/ui/design-system';
import { OnlineOnly } from '@/components/ui/online-only';
import { cn } from '@/lib/cn';
import type { PlaybackControllerState } from './playback-controller-api';
import { deleteSessionConfirm } from './player-presentation';

const TONE_STYLES = {
  ok: '',
  info: 'border-signal/35 bg-signal-dim text-paper',
  warn: 'border-lamp/35 bg-lamp/[0.08] text-paper',
  error: 'border-warn/40 bg-warn/[0.08] text-paper',
} as const;

/** The live controller state the banner reads: the status and the server's safe
 *  message, plus what the Session actually has — a block reads differently
 *  against a playable Queue than against a cold start with nothing to play. */
export type GenerationBannerPlayer = Pick<
  PlaybackControllerState,
  | 'generationStatus'
  | 'generationStatusScope'
  | 'statusMessageSafe'
  | 'queueLength'
  | 'pendingGeneration'
>;

export function GenerationBanner({
  player,
  action,
}: {
  player: GenerationBannerPlayer;
  /** The way out of a dead end — a block the Session can still recover from
   *  never offers one. */
  action?: ReactNode;
}) {
  const p = presentGenerationStatus(
    player.generationStatus,
    player.statusMessageSafe,
    player.generationStatusScope,
    { readyTrackCount: player.queueLength, generationInFlight: player.pendingGeneration != null },
  );
  if (!p.message) return null;

  const Icon = p.isSessionRepeat
    ? Repeat
    : p.tone === 'error'
      ? AlertTriangle
      : p.tone === 'warn'
        ? Loader2
        : Info;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="generation-status"
      data-status={player.generationStatus}
      className={cn(
        'flex items-start gap-2.5 rounded-card-sm border px-4 py-3 text-[13.5px]',
        TONE_STYLES[p.tone],
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {p.title ? <p className="font-semibold">{p.title}</p> : null}
        <p className="text-[12px] leading-relaxed text-muted">{p.message}</p>
        {p.showCostSettingsLink ? (
          <Link
            href={p.costSettingsPath}
            className="mt-1 inline-block text-[11px] font-medium underline underline-offset-2"
          >
            {p.costSettingsLabel}
          </Link>
        ) : null}
        {p.isStuck && action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Delete Session from the banner: the same confirmed stop-then-delete the
 *  options sheet's row runs, offered where the dead end is actually visible. */
export function DeleteSessionAction({
  sessionTitle,
  onDelete,
}: {
  sessionTitle: string;
  /** Stop the Session and delete it; reports its own failures on the player's
   *  error surface rather than throwing. */
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const close = () => setConfirming(false);

  return (
    <>
      <OnlineOnly>
        <button
          type="button"
          data-testid="generation-status-delete-session"
          onClick={() => setConfirming(true)}
          className={compactDangerButtonClass}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          Delete Session
        </button>
      </OnlineOnly>
      {confirming ? (
        <ConfirmDialog
          {...deleteSessionConfirm(sessionTitle)}
          onConfirm={async () => {
            await onDelete();
            close();
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}
