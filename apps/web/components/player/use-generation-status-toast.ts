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
const STATUS_KEY = 'generation-status';

const TOAST_TONE: Record<GenerationStatusTone, ToastTone | null> = {
  ok: null,
  info: 'info',
  warn: 'warning',
  error: 'error',
};

export function useGenerationStatusToast(
  player: GenerationBannerPlayer | null,
  onPlayerPage: boolean,
  sessionId: string | null,
): void {
  const banner = player ? presentGenerationBanner(player) : null;
  const tone = banner ? TOAST_TONE[banner.tone] : null;
  const shown =
    banner?.message && tone
      ? {
          tone,
          message: banner.message,
          options: {
            key: STATUS_KEY,
            ...(banner.title ? { title: banner.title } : {}),
            ...(banner.showCostSettingsLink
              ? { link: { label: banner.costSettingsLabel, href: banner.costSettingsPath } }
              : {}),
          },
        }
      : null;
  // What the toast says, for this Session: a poll that changes nothing it says
  // stays silent, and a poll that changes the copy (the first one bringing the
  // ready Tracks) updates it.
  const said = shown ? JSON.stringify([sessionId, shown]) : null;
  const lastSaid = useRef<string | null>(null);

  useEffect(() => {
    // On the Player the banner is in sight, so a toast from another page
    // would say the same thing twice.
    if (onPlayerPage) {
      lastSaid.current = said;
      toast.dismiss(STATUS_KEY);
      return;
    }
    if (lastSaid.current === said) return;
    lastSaid.current = said;
    // With nothing for the banner to say, an older toast describes a stale status.
    if (!shown) {
      toast.dismiss(STATUS_KEY);
      return;
    }
    toast[shown.tone](shown.message, shown.options);
  }, [said, shown, onPlayerPage]);
}
