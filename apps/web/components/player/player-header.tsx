'use client';

// The now-playing header shared by both Playback sources: one row carrying the
// source's own indicators, the blend toggle, the retention actions and the
// options slot, then the status line, the title, the subtitle, and the live
// announcement. Both surfaces render the SAME header — keeping it here means a
// spacing or control change is one edit, not one per source. What only one
// source has arrives as a slot, so the header's own props stay narrow.

import type { ReactNode } from 'react';
import { OnlineOnly } from '@/components/ui/online-only';
import { BlendToggleButton } from './blend-toggle';
import { sectionLoopControl, type PlaybackControllerApi } from './playback-controller-api';
import { ScrambleText } from './scramble-text';
import { SectionLoopToggleButton } from './section-loop-toggle';
import { TrackRetentionActions } from './track-retention-actions';

/** What this header reads off the controller — the blend gate and the current
 * Track's two retention shelves. */
type HeaderPlayer = Pick<
  PlaybackControllerApi,
  | 'blendEnabled'
  | 'toggleBlend'
  | 'currentFavorited'
  | 'currentInCuratedPlaylist'
  | 'toggleFavorite'
  | 'sectionLoopTool'
  | 'sectionLoopAvailable'
  | 'toggleSectionLoopTool'
>;

export function PlayerHeader({
  statusLabel,
  title,
  subtitle,
  announcement,
  controls,
  statusMark,
  newMusic,
  options,
}: {
  /** The status line above the title (a source may suffix its own kind). */
  statusLabel: string;
  /** Set before the status line: the source is Available offline. */
  statusMark?: ReactNode;
  title: string;
  subtitle: string;
  /** The polite live-region sentence read when either line changes. */
  announcement: string;
  /** The blend toggle and the retention actions. Absent in the Offline
   * Library, where both would write to the server. */
  controls?: {
    /** Retention acts on the current Track, so an empty deck disables it; the
     * blend toggle is a persisted setting and stays live regardless. */
    hasTrack: boolean;
    player: HeaderPlayer;
    /** Opens the source's own playlist picker (retention is membership). Live on
     * the Lounge visitor scope too: saving a foreign Track files a
     * Shared reference into the LISTENER's own playlists. */
    onAddToPlaylist: () => void;
  };
  /** The Session's New Music status; a Playlist generates nothing and omits it. */
  newMusic?: ReactNode;
  /** The source's options control, revealed on the desk breakpoint only. */
  options: ReactNode;
}) {
  return (
    <>
      {/* The controls own a row so a long status line ("Preparing your
          Session", or a shorter one plus a source suffix) never collides with
          them. Beside the cover it rises by the padding around its icons, so
          the icons themselves line up with the cover's top edge. */}
      <div className="flex items-center justify-end gap-2 @split:-mt-[10px]">
        {newMusic}
        {controls ? (
          // The blend setting and the retention actions save on the server;
          // looping a part only needs the audio this device already has.
          <>
            <OnlineOnly>
              <BlendToggleButton
                enabled={controls.player.blendEnabled}
                onToggle={controls.player.toggleBlend}
              />
            </OnlineOnly>
            <SectionLoopToggleButton {...sectionLoopControl(controls.player)} />
            <OnlineOnly>
              <TrackRetentionActions
                disabled={!controls.hasTrack}
                favorited={controls.player.currentFavorited}
                inCuratedPlaylist={controls.player.currentInCuratedPlaylist}
                onAddToPlaylist={controls.onAddToPlaylist}
                onToggleFavorite={controls.player.toggleFavorite}
              />
            </OnlineOnly>
          </>
        ) : null}
        <span className="hidden flex-none desk:inline-flex">{options}</span>
      </div>
      <div className="mt-3 flex items-center font-mono text-[10px] uppercase tracking-[0.16em] text-lamp desk:mt-6">
        {statusMark}
        <span className="truncate">{statusLabel}</span>
      </div>
      <h1
        data-testid="track-title"
        className="mt-1 truncate font-display text-[25px] font-extrabold leading-[1.15] tracking-[-0.02em]"
      >
        <ScrambleText text={title} />
      </h1>
      <div data-testid="track-subtitle" className="mt-1 truncate text-[13.5px] text-muted">
        <ScrambleText text={subtitle} />
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </>
  );
}
