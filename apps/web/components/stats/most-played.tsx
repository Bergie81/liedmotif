'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Music } from 'lucide-react';
import { CoverArt } from '@/components/player/cover-art';
import { usePlaySessionTrack } from '@/components/player/use-play-session-track';
import { AlertBanner, Meter } from '@/components/ui/design-system';
import { cn } from '@/lib/cn';
import { emptyClass } from './stats-parts';
import type { TrackRow } from './your-stats-model';

const rowClass = 'group flex w-full items-center gap-2 py-2 text-left';

/** A row a tap does nothing on reads quieter than one that leads somewhere. */
function titleClass(playing: boolean, action: TrackRow['action']): string {
  if (playing) return 'text-lamp';
  return action ? 'text-paper' : 'text-muted';
}

function Cover({ coverImageId }: { coverImageId: string | null }) {
  return (
    // 48px keeps the 160px thumbnail rendition sharp on a dense screen.
    <span className="block h-12 w-12 shrink-0 overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_var(--line)]">
      <CoverArt
        coverImageId={coverImageId}
        thumb
        className="h-full w-full object-cover"
        fallback={
          <span className="flex h-full w-full items-center justify-center bg-panel-2 text-dim">
            <Music className="h-4 w-4" aria-hidden />
          </span>
        }
      />
    </span>
  );
}

/**
 * Most-played Tracks, one to a row: cover, title, and the share of all plays as
 * a line. A row plays its Track in the Session it came from.
 */
export function MostPlayed({ rows }: { rows: TrackRow[] }) {
  const [playError, setPlayError] = useState<string | null>(null);
  const { playViaSession, busyTrackId, transportRowPreview } = usePlaySessionTrack(setPlayError);
  if (rows.length === 0) {
    return <p className={emptyClass}>No plays recorded in this period.</p>;
  }
  // Lines are drawn against the leader's share, so the ranking stays readable
  // when every share is small.
  const topShare = rows[0]?.share ?? 0;
  return (
    <>
      {playError ? <AlertBanner className="mb-4">{playError}</AlertBanner> : null}
      <ol>
        {rows.map(({ key, label, coverImageId, plays, share, action }, index) => {
          const playing =
            action?.kind === 'play' &&
            action.track.id === transportRowPreview.trackId &&
            transportRowPreview.state === 'playing';
          const body = (
            <>
              <span
                className={cn(
                  'w-4 shrink-0 text-center font-mono text-[11px]',
                  index === 0 ? 'text-lamp' : 'text-dim',
                )}
              >
                {index + 1}
              </span>
              <Cover coverImageId={coverImageId} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      'min-w-0 truncate text-[14.5px] font-semibold group-hover:text-lamp',
                      titleClass(playing, action),
                    )}
                  >
                    {label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tracking-[0.05em] text-muted">
                    {plays}
                  </span>
                </span>
                <span className="mt-2 flex items-center gap-2">
                  <Meter
                    value={share}
                    max={topShare}
                    label={`${label}: ${share}% of your plays`}
                    className="flex-1"
                  />
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] text-paper">
                    {share}%
                  </span>
                </span>
              </span>
            </>
          );
          return (
            <li
              key={key}
              className="border-b border-line first:[&>*]:pt-0 last:border-b-0 last:[&>*]:pb-0"
            >
              {action?.kind === 'play' ? (
                <button
                  type="button"
                  className={rowClass}
                  disabled={busyTrackId !== null}
                  aria-label={`Play ${label}`}
                  onClick={() => {
                    setPlayError(null);
                    void playViaSession(action.track);
                  }}
                >
                  {body}
                </button>
              ) : action?.kind === 'open' ? (
                <Link href={action.href} className={rowClass}>
                  {body}
                </Link>
              ) : (
                <div className={rowClass}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
