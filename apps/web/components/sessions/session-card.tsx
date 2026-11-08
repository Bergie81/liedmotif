'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Disc3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { RelativeTime } from '@/components/relative-time';
import { coverArtSrc } from '@/components/player/player-presentation';
import { cardShellClass } from '@/components/ui/design-system';
import { OnlineOnly } from '@/components/ui/online-only';
import { OfflineMark } from '@/components/offline/offline-mark';
import { useOpenSessionTracks } from './session-tracks-sheet';
import { formatGenreLine, formatSessionTrackLine } from './session-list-model';

type SessionCardProps = {
  sessionId: string;
  trackCount: number;
  title: string | null;
  coverImageId: string | null;
  genreTags?: string[];
  activityFallback?: string;
  details?: ReactNode;
  active?: boolean;
  coverVariant?: number;
  className?: string;
  /** Sits above the card's click surface, so it never opens the card. */
  action?: ReactNode;
} &
  /** With neither, opens the Tracks list whatever their count: a tap never starts playback or spends. */
  ({ href?: string; onClick?: never } | { href?: never; onClick: () => void });

export function SessionCardLastActiveDetails({
  trackCount,
  totalDurationSeconds,
  lastActiveAt,
}: {
  trackCount: number;
  totalDurationSeconds: number;
  lastActiveAt: string;
}) {
  // The dot hangs in the padding left of "last active": when that wraps to its
  // own line the dot lands in the negative margin and is clipped, so no line
  // ends or starts on a separator.
  return (
    <span className="block overflow-hidden">
      <span className="-ml-4 flex flex-wrap items-baseline">
        <span className="whitespace-nowrap pl-4">
          {formatSessionTrackLine(trackCount, totalDurationSeconds)}
        </span>
        <span className="relative pl-4 before:absolute before:left-[6px] before:content-['·']">
          last active <RelativeTime iso={lastActiveAt} />
        </span>
      </span>
    </span>
  );
}

export function SessionCard({
  sessionId,
  trackCount,
  title,
  coverImageId,
  genreTags = [],
  activityFallback,
  details,
  action,
  href,
  onClick,
  active = false,
  coverVariant = 0,
  className,
}: SessionCardProps) {
  const openTracks = useOpenSessionTracks();
  const chooseTrack = trackCount > 1 || !(href || onClick);
  const activity = formatGenreLine(genreTags) ?? activityFallback;

  const content = (
    <>
      <div
        className={cn(
          "relative min-h-[88px] overflow-hidden bg-panel-2 after:absolute after:inset-0 after:bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.035)_0_1px,transparent_1px_3px)] after:mix-blend-overlay after:content-['']",
          !coverImageId &&
            (coverVariant % 2 === 0
              ? '[background:radial-gradient(120%_120%_at_20%_10%,#3b2f63,#14101f_70%)]'
              : '[background:linear-gradient(160deg,#0e2a26,#10131f_75%)]'),
        )}
      >
        {coverImageId ? (
          <Image
            src={coverArtSrc(coverImageId, 'thumb')}
            alt=""
            width={88}
            height={88}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <Disc3
            className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-paper/45"
            aria-hidden
          />
        )}
      </div>

      <div className="self-center px-3 py-3">
        <h3 className="truncate font-display text-[16px] font-bold tracking-[-0.01em]">
          {title ?? 'Untitled Session'}
        </h3>
        {activity ? (
          <p className="mt-2 truncate font-mono text-[10.5px] uppercase leading-[1.65] tracking-[0.08em] text-muted">
            {activity}
          </p>
        ) : null}
        {details ? (
          <div className="mt-0.5 flex items-baseline text-[12.5px] text-dim">
            {/* A flex row ignores the mark's own vertical-align, so the drop that
                seats it on a line of text is set here. */}
            <OfflineMark kind="session" id={sessionId} className="mr-1.5 translate-y-[2px]" />
            <div className="min-w-0">{details}</div>
          </div>
        ) : null}
      </div>
    </>
  );
  // The ::after stretches the click surface over the whole card, rail included.
  const bodyClass =
    "grid min-w-0 grid-cols-[88px_minmax(0,1fr)] text-left *:min-w-0 after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lamp";

  return (
    <article
      className={cn(
        cardShellClass,
        'relative grid grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-l-[8px] transition-[translate,border-color,box-shadow] motion-reduce:translate-none motion-reduce:transition-none',
        // `!`: `cn` doesn't merge, so these must outrank the shell's own border and shadow.
        active
          ? 'border-lamp! shadow-[0_0_0_1px_var(--lamp),0_10px_40px_-12px_var(--lamp-glow)]! duration-300 ease-out hover:shadow-[0_0_0_1px_var(--lamp),0_14px_56px_-6px_var(--lamp-glow)]!'
          : 'duration-200 ease-[ease] hover:-translate-y-0.5 hover:border-lamp/60 hover:shadow-[0_14px_44px_-10px_var(--lamp-glow)]',
        className,
      )}
    >
      {href && !chooseTrack ? (
        <Link href={href} className={bodyClass}>
          {content}
        </Link>
      ) : (
        <OnlineOnly>
          <button
            type="button"
            onClick={(event) => {
              if (chooseTrack) {
                openTracks({ id: sessionId, title, coverImageId, genreTags }, event.currentTarget);
              } else {
                onClick?.();
              }
            }}
            aria-haspopup={chooseTrack ? 'dialog' : undefined}
            className={bodyClass}
          >
            {content}
          </button>
        </OnlineOnly>
      )}
      {action ? <div className="relative z-10 self-start pr-1 pt-1">{action}</div> : null}
    </article>
  );
}
