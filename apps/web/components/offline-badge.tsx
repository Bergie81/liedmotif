'use client';

import { WifiOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useOnline } from '@/lib/online-state';
import { OFFLINE_HINT } from './ui/online-only';

/**
 * The shell's sign that the app is listen-only, present only while offline.
 * `chip` sits in a phone header; `rail` in the desk sidebar, where the
 * collapsed rail keeps only the glyph.
 */
export function OfflineBadge({ variant = 'chip' }: { variant?: 'chip' | 'rail' }) {
  if (useOnline()) return null;
  return (
    <span
      role="status"
      data-testid="offline-badge"
      title="Offline — listening only until the connection returns"
      className={cn(
        'shrink-0 items-center whitespace-nowrap font-mono uppercase text-warn',
        variant === 'chip'
          ? 'inline-flex gap-1.5 rounded-full border border-warn/50 bg-[var(--control-bg)] px-3 py-1 text-[11px] tracking-[0.05em]'
          : 'flex w-full justify-center gap-2 px-2 pb-3 text-[10.5px] tracking-[0.08em] rail-exp:justify-start',
      )}
    >
      <WifiOff className="h-[13px] w-[13px] flex-none" aria-hidden />
      <span className={variant === 'rail' ? 'sr-only rail-exp:not-sr-only' : undefined}>
        {OFFLINE_HINT}
      </span>
    </span>
  );
}
