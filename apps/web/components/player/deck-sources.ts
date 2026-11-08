// Per-deck pinned-source loading (the source ladder).
//
// Owns each deck's ladder walk: which pinned URL is loading, stepping down on
// `error` (a pinned final 404s until the download lands; the pinned stream is
// the next rung), and the SOURCE COMMIT — `HTMLMediaElement` exposes no
// response headers, so the pinned URL that reached readiness IS the committed
// source kind. Decks never load unpinned URLs, with one exception: a Track
// this device stores Available offline plays its stored copy, the local final
// itself, ahead of its pinned rungs (an object URL each deck holds only while
// it carries the Track).

import {
  pinnedSourceLadder,
  type CommittedSourceKind,
  type PinnedSourceStep,
} from '@liedmotif/shared';
import type { DeckId } from './audio-engine';
import type { PlayableTrack } from './playable-track';

interface DeckLoad {
  steps: PinnedSourceStep[];
  stepIndex: number;
  /** The kind of the pinned URL that reached readiness; null while loading. */
  committed: CommittedSourceKind | null;
  /** The object URL over the device's stored copy, while the deck may use it. */
  storedUrl: string | null;
}

export class DeckSources {
  private loads: Record<DeckId, DeckLoad | null> = { a: null, b: null };

  constructor(
    private readonly deckEl: (deck: DeckId) => HTMLAudioElement | null,
    /** The device's stored copy of a Track, or null: it streams. */
    private readonly storedAudio: (trackId: string) => Blob | null = () => null,
  ) {}

  /** Start a deck's ladder walk. False when the track has neither a stored
   *  copy nor pinned assets. */
  begin(deck: DeckId, track: PlayableTrack): boolean {
    const el = this.deckEl(deck);
    if (!el) return false;
    const stored = this.storedAudio(track.trackId);
    const storedUrl = stored ? URL.createObjectURL(stored) : null;
    const steps: PinnedSourceStep[] = [
      ...(storedUrl ? [{ kind: 'final' as const, url: storedUrl }] : []),
      ...pinnedSourceLadder(track.assets),
    ];
    const first = steps[0];
    if (!first) return false;
    const previous = this.loads[deck];
    this.loads[deck] = { steps, stepIndex: 0, committed: null, storedUrl };
    // Every ladder load starts at 1× — a rate nudge left by an earlier aligned
    // edge must never leak into the next track (an aligned plan re-applies its
    // own rate later, deliberately).
    el.playbackRate = 1;
    el.src = first.url;
    el.load();
    this.releaseStored(previous);
    return true;
  }

  /** Stop + unload the deck element and clear its ladder state. */
  unload(deck: DeckId): void {
    const el = this.deckEl(deck);
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
      el.playbackRate = 1;
    }
    this.clear(deck);
  }

  /** Forget the ladder state, and let go of the stored copy, without touching
   *  the element (deck went idle). */
  clear(deck: DeckId): void {
    this.releaseStored(this.loads[deck]);
    this.loads[deck] = null;
  }

  /** The decks are going away: let go of every stored copy they hold. */
  dispose(): void {
    this.clear('a');
    this.clear('b');
  }

  private releaseStored(load: DeckLoad | null): void {
    if (!load?.storedUrl) return;
    URL.revokeObjectURL(load.storedUrl);
    load.storedUrl = null;
  }

  committedKind(deck: DeckId): CommittedSourceKind | null {
    return this.loads[deck]?.committed ?? null;
  }

  /** `canplay`: commit the source kind. True when this readiness NEWLY
   * committed. Guarded against STALE events from a superseded load attempt
   * (cancel → immediate reload on the same element): a queued `canplay` task
   * belonging to the aborted resource must not commit the new ladder, so the
   * commit requires the element to REALLY be ready right now
   * (`readyState ≥ HAVE_FUTURE_DATA` — reset by the load algorithm). */
  commitOnReady(deck: DeckId): boolean {
    const el = this.deckEl(deck);
    const load = this.loads[deck];
    if (!el || !load || load.committed != null) return false;
    // Numeric HAVE_FUTURE_DATA: the HTMLMediaElement global is absent in the
    // node-environment unit tests.
    if (el.readyState < 3) return false;
    load.committed = load.steps[load.stepIndex]?.kind ?? null;
    return load.committed != null;
  }

  /** `error` before commit: try the next rung. True when another rung loads.
   * Stale-guarded like `commitOnReady`: `el.error` is nulled by the load
   * algorithm, so an error task from a superseded attempt (no live error on
   * the element) must not step the NEW ladder down. */
  stepDown(deck: DeckId): boolean {
    const el = this.deckEl(deck);
    const load = this.loads[deck];
    if (!el || !load || load.committed != null) return false;
    if (el.error == null) return false;
    const step = load.steps[load.stepIndex + 1];
    if (!step) return false;
    load.stepIndex += 1;
    el.src = step.url;
    el.load();
    this.releaseStored(load);
    return true;
  }
}
