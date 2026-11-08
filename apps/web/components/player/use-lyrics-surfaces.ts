'use client';

import { useEffect, useState } from 'react';
import { showLyricsAffordance, type LyricsGate } from './lyrics-view';

export interface LyricsSurfaces {
  /** Whether the sleeve flip and the Lyrics row render at all. */
  lyricsAvailable: boolean;
  lyricsSheetOpen: boolean;
  setLyricsSheetOpen: (open: boolean) => void;
}

/**
 * The lyrics surfaces of a player view: they exist only while the current Track
 * has words to show, so a Track that has none (session handoff, stop, an
 * instrumental next up) closes the sheet with it. The sleeve's own flip state
 * lives in `PlayerCoverSleeve`; the sheet is owned out here because an options
 * row opens it too — two owners would let the surfaces stack.
 */
export function useLyricsSurfaces(track: LyricsGate | null): LyricsSurfaces {
  const lyricsAvailable = showLyricsAffordance(track);
  const [lyricsSheetOpen, setLyricsSheetOpen] = useState(false);
  useEffect(() => {
    if (!lyricsAvailable) setLyricsSheetOpen(false);
  }, [lyricsAvailable]);

  return { lyricsAvailable, lyricsSheetOpen, setLyricsSheetOpen };
}
