'use client';

// Off the Player nothing renders the generation banner, so the playing
// Session's new music pausing would pass unseen. The live controller keeps the
// status fresh on every route; this turns each change of it into one toast
// that says what the banner would. On the Player the banner says it already.

import { useEffect, useRef } from 'react';
import type { GenerationStatusTone } from '@liedmotif/shared';
import { toast, type ToastTone } from '@/lib/toast';
import { presentGenerationBanner, type GenerationBannerPlayer } from './generation-banner';

/** One key for every status, so a newer status replaces the older toast. */
const TOAST_KEY = 'generation-status';

const TOAST_TONE: Record<GenerationStatusTone, ToastTone | null> = {
  ok: null,
  info: 'info',
  warn: 'warning',
  error: 'error',
};

export function useGenerationStatusToast(
  player: GenerationBannerPlayer | null,
  onPlayerPage: boolean,
): void {
  const status = player?.generationStatus ?? 'ok';
  const lastStatus = useRef<typeof status>('ok');

  useEffect(() => {
    if (lastStatus.current === status) return;
    lastStatus.current = status;
    const banner = player ? presentGenerationBanner(player) : null;
    const tone = banner ? TOAST_TONE[banner.tone] : null;
    // The toast speaks for the banner only while the banner is out of sight
    // and has something to say; past that it would describe a stale status.
    if (onPlayerPage || !banner?.message || !tone) {
      toast.dismiss(TOAST_KEY);
      return;
    }
    toast[tone](banner.message, {
      key: TOAST_KEY,
      ...(banner.title ? { title: banner.title } : {}),
      ...(banner.showCostSettingsLink
        ? { link: { label: banner.costSettingsLabel, href: banner.costSettingsPath } }
        : {}),
    });
  }, [status, onPlayerPage, player]);
}
