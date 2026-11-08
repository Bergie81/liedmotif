// Deck `ended` handling (the `reportPlaybackState` contract).
//
// The player runs two <audio> decks and arms an equal-power crossfade onto the
// other deck one crossfade-length before the current track ends — so the active
// deck is switched to the INCOMING deck while the OUTGOING deck is still playing
// out its tail. When the outgoing deck later fires `ended`, the handler must report
// `ended` for the track THAT deck was carrying (not the already-swapped-in active
// track) and must NOT advance again (the crossfade already advanced). This pure
// decision keeps that bookkeeping correct and testable without a DOM audio graph.

/** Which of the two player decks (matches the engine's `DeckId`). */
export type PlayerDeckId = 'a' | 'b';

/** The per-deck loaded-track bookkeeping the player tracks plus the active deck. */
export interface DeckPlaybackState<T> {
  activeDeck: PlayerDeckId;
  /** The track each deck is currently carrying (null once cleared / never loaded). */
  loaded: Record<PlayerDeckId, T | null>;
}

/** What to do when `deck` fires `ended`. */
export interface DeckEndedOutcome<T> {
  /** Report `ended` for this track — always the ended deck's own track, or null. */
  endedTrack: T | null;
  /** Advance to the next track only when the ended deck is still the active deck. */
  advance: boolean;
}

/**
 * Resolve the `ended` handling for `endedDeck`: report `ended` for the track that
 * deck was carrying, and advance only when that deck is still the active one. An
 * outgoing deck ending mid-crossfade reports `ended` (so play-history stays correct)
 * but does not advance (avoiding a double-advance past the incoming track).
 */
export function deckEndedOutcome<T>(
  state: DeckPlaybackState<T>,
  endedDeck: PlayerDeckId,
): DeckEndedOutcome<T> {
  return {
    endedTrack: state.loaded[endedDeck],
    advance: endedDeck === state.activeDeck,
  };
}
