// The media-deck DOM event lifecycle: owns the four deck listeners —
// timeupdate (transition trigger), canplay (source commit), ended (report +
// advance-vs-release), error (ladder walk → failure classification) — and their
// binding. This module decides WHAT each event means; the ports supply the
// player state it reads and the actions it triggers. Split from the controller
// hook so deck-event semantics change in one place.

import {
  crossfadeStartSeconds,
  deckEndedOutcome,
  type PlaybackReportType,
} from '@liedmotif/shared';
import type { DeckId } from './audio-engine';
import type { DeckSources } from './deck-sources';
import type { EdgeTransitions } from './edge-transitions';
import type { PlayableTrack } from './playable-track';

export interface DeckLifecyclePorts {
  deckEl(deck: DeckId): HTMLAudioElement | null;
  activeDeck(): DeckId;
  deckTrack(deck: DeckId): PlayableTrack | null;
  clearDeckTrack(deck: DeckId): void;
  sources(): DeckSources;
  transitions(): EdgeTransitions;
  /** Whether the deck plays a decoded buffer and its element is only the
   *  muted focus/Media-Session carrier. */
  bufferCarrying(deck: DeckId): boolean;
  /** Whether the live blend runs at all (graph + settled owner setting). */
  blendActive(): boolean;
  crossfadeSeconds(): number;
  wantPlay(): boolean;
  report(
    type: PlaybackReportType,
    track: PlayableTrack | null,
    positionSeconds: number | null,
  ): void;
  /** Natural advance (next / Session-Repeat wrap / wait). */
  advance(): void;
  /** Advance off a DEAD source: never loops back onto the same dead audio. */
  advanceOffFailure(): void;
  /** Re-attempt playback after a ladder step-down on the active deck. */
  resumePlay(deck: DeckId, el: HTMLAudioElement, track: PlayableTrack): void;
  unloadDeck(deck: DeckId): void;
  /** A deck's pinned source just COMMITTED (its kind is now known) — the
   *  controller refreshes committed-kind-derived UI state (the loop toggle
   *  is offered only while the audible source is a downloaded final). */
  onSourceCommitted(deck: DeckId): void;
}

/**
 * The one `ended` outcome for BOTH transports — an element's `ended` event and
 * a buffer source's natural `onended` mean the same thing: report `ended` for
 * the track THIS deck was carrying (during a crossfade the active deck has
 * already moved on) and advance only if the deck is still active. On an
 * advance the deck-track ref stays set THROUGH the call — next-index
 * resolution needs the ended track's identity; every advance path clears the
 * deck afterwards.
 */
export function handleDeckEnded(
  ports: DeckLifecyclePorts,
  deck: DeckId,
  positionSeconds: number | null,
): void {
  const { endedTrack, advance } = deckEndedOutcome(
    {
      activeDeck: ports.activeDeck(),
      loaded: { a: ports.deckTrack('a'), b: ports.deckTrack('b') },
    },
    deck,
  );
  if (endedTrack) ports.report('ended', endedTrack, positionSeconds);
  if (advance) {
    ports.advance();
  } else {
    ports.clearDeckTrack(deck);
    ports.sources().clear(deck);
    ports.deckEl(deck)?.pause();
  }
}

/** Bind the deck listeners to both elements; returns the unbind cleanup. */
export function bindDeckLifecycle(
  elements: Record<DeckId, HTMLAudioElement>,
  ports: DeckLifecyclePorts,
): () => void {
  const onTimeUpdate = (deck: DeckId) => () => {
    if (deck !== ports.activeDeck()) return;
    // Blending off / no graph → strictly sequential playback: never prepare,
    // never start the incoming deck early; `ended` advances.
    if (!ports.blendActive()) return;
    const el = ports.deckEl(deck);
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    // A PAUSED element also fires `timeupdate` — once on the pause itself and
    // on every seek (a paused lock-screen scrub) — but its position is
    // frozen: a preparation begun off it would burn its readiness deadline
    // against a clock that isn't moving, and a beat-locked edge could even
    // ARM an audible buffer start against a paused session. Resume's
    // `play()` restores the live ticks that drive the trigger. (The dead-
    // carrier cadence path calls the driver directly and stays unaffected.)
    if (el.paused) return;
    ports
      .transitions()
      .onTimeUpdate(el, crossfadeStartSeconds(el.duration, ports.crossfadeSeconds()));
  };

  const onCanPlay = (deck: DeckId) => () => {
    // Source commit: the pinned URL that reached readiness IS the source kind.
    if (!ports.sources().commitOnReady(deck)) return;
    ports.onSourceCommitted(deck);
    ports.transitions().onDeckReady(deck);
  };

  const onEnded = (deck: DeckId) => () => {
    // A buffer-carrying deck's element is only the muted carrier: its `ended`
    // is an echo — the buffer source's own natural end (which lands within
    // milliseconds) reports and advances. Park the carrier and wait.
    if (ports.bufferCarrying(deck)) {
      ports.deckEl(deck)?.pause();
      return;
    }
    handleDeckEnded(ports, deck, ports.deckEl(deck)?.currentTime ?? null);
  };

  const onError = (deck: DeckId) => () => {
    const el = ports.deckEl(deck);
    // A stale error task from a superseded load attempt carries no live
    // element error (`el.error` is nulled by the load algorithm) — ignore it;
    // the new attempt's own events follow.
    if (!el || el.error == null) return;
    // A buffer-carrying deck's AUDIO is the decoded buffer — a carrier element
    // dying costs lock-screen focus at worst, never playback. Ignore it.
    if (ports.bufferCarrying(deck)) return;
    // Walk the pinned source ladder before declaring the source dead: a pinned
    // final 404s until the download lands; the pinned stream is the next rung.
    if (ports.sources().stepDown(deck)) {
      const track = ports.deckTrack(deck);
      if (deck === ports.activeDeck() && track && ports.wantPlay()) {
        ports.resumePlay(deck, el, track);
      }
      return;
    }
    // Ladder exhausted (or the source died later). A preparation's deck is the
    // transition driver's problem; a post-handoff OUTGOING tail is closed out
    // and released (or it would block later preparations); the ACTIVE deck
    // reports `failed` and moves on.
    if (ports.transitions().onDeckFailed(deck)) return;
    const track = ports.deckTrack(deck);
    if (deck !== ports.activeDeck()) {
      if (track) {
        ports.report('ended', track, el?.currentTime ?? null);
        ports.unloadDeck(deck);
      }
      return;
    }
    if (!track) return;
    // Report `failed` for the track THIS deck carries (the audible identity),
    // then move OFF the dead source — a src that 404s (audio purged between
    // poll and play) must not stall silently in "Now playing". Advance
    // like the ended path, but never onto audio that already failed since the
    // last confirmed start: an automatic retry of dead audio would hammer it.
    // With no live audio left this falls back to `waiting`, and the poll's
    // resume path retries once per poll while the user wants play.
    ports.report('failed', track, null);
    ports.advanceOffFailure();
  };

  const cleanups = (Object.entries(elements) as Array<[DeckId, HTMLAudioElement]>).map(
    ([deck, el]) => {
      const tu = onTimeUpdate(deck);
      const cp = onCanPlay(deck);
      const en = onEnded(deck);
      const er = onError(deck);
      el.addEventListener('timeupdate', tu);
      el.addEventListener('canplay', cp);
      el.addEventListener('ended', en);
      el.addEventListener('error', er);
      return () => {
        el.removeEventListener('timeupdate', tu);
        el.removeEventListener('canplay', cp);
        el.removeEventListener('ended', en);
        el.removeEventListener('error', er);
      };
    },
  );

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
