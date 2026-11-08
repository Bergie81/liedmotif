export const PLAYBACK_MODES = ['loop-session', 'loop-track', 'shuffle'] as const;

export type PlaybackMode = (typeof PLAYBACK_MODES)[number];

export interface ShuffleState {
  /** Queue item ids still to play in this shuffle pass; the head is prepared next. */
  bag: string[];
  /** Tracks actually departed during this shuffle run, oldest to newest. */
  history: string[];
  /** Distinguishes fresh queue arrivals from tracks already played in this pass. */
  knownQueueItemIds: string[];
}

export interface ShuffleTarget {
  state: ShuffleState;
  queueItemId: string | null;
}

export function cyclePlaybackMode(mode: PlaybackMode): PlaybackMode {
  const index = PLAYBACK_MODES.indexOf(mode);
  return PLAYBACK_MODES[(index + 1) % PLAYBACK_MODES.length]!;
}

export function resolveOrderedNextIndex(queueLength: number, currentIndex: number): number | null {
  if (queueLength <= 0) return null;
  if (currentIndex < 0) return 0;
  const next = currentIndex + 1;
  return next < queueLength ? next : 0;
}

export function createShuffleState(
  playableQueueItemIds: readonly string[],
  currentQueueItemId: string | null,
  random: () => number = Math.random,
): ShuffleState {
  const knownQueueItemIds = unique(playableQueueItemIds);
  return {
    bag: shuffle(
      knownQueueItemIds.filter((queueItemId) => queueItemId !== currentQueueItemId),
      random,
    ),
    history: [],
    knownQueueItemIds,
  };
}

/** Reconcile a traversal with the live playable projection. Removed tracks vanish;
 * genuinely new arrivals enter a uniformly random remaining-bag position. */
export function syncShuffleState(
  state: ShuffleState,
  playableQueueItemIds: readonly string[],
  currentQueueItemId: string | null,
  random: () => number = Math.random,
): ShuffleState {
  const knownQueueItemIds = unique(playableQueueItemIds);
  const playable = new Set(knownQueueItemIds);
  const previouslyKnown = new Set(state.knownQueueItemIds);
  let bag = unique(state.bag).filter(
    (queueItemId) => playable.has(queueItemId) && queueItemId !== currentQueueItemId,
  );
  const history = state.history.filter((queueItemId) => playable.has(queueItemId));

  for (const queueItemId of knownQueueItemIds) {
    if (
      queueItemId === currentQueueItemId ||
      previouslyKnown.has(queueItemId) ||
      bag.includes(queueItemId)
    ) {
      continue;
    }
    const insertionIndex = randomIndex(bag.length + 1, random);
    bag = [...bag.slice(0, insertionIndex), queueItemId, ...bag.slice(insertionIndex)];
  }

  return { bag, history, knownQueueItemIds };
}

/** Resolve the actual next shuffle pick without consuming it. This lets the audio
 * engine prepare the same track that natural-end playback will commit. */
export function peekShuffleTarget(
  state: ShuffleState,
  playableQueueItemIds: readonly string[],
  currentQueueItemId: string | null,
  random: () => number = Math.random,
): ShuffleTarget {
  let next = syncShuffleState(state, playableQueueItemIds, currentQueueItemId, random);
  if (next.bag.length === 0) {
    const candidates = next.knownQueueItemIds.filter(
      (queueItemId) => queueItemId !== currentQueueItemId,
    );
    next = { ...next, bag: shuffle(candidates, random) };
  }

  return {
    state: next,
    queueItemId:
      next.bag[0] ??
      (next.knownQueueItemIds.length === 1 ? (next.knownQueueItemIds[0] ?? null) : null),
  };
}

/** Consume a prepared/manual target and record the track it followed for Back. */
export function commitShuffleTarget(
  state: ShuffleState,
  outgoingQueueItemId: string | null,
  targetQueueItemId: string,
): ShuffleState {
  const history =
    outgoingQueueItemId && outgoingQueueItemId !== targetQueueItemId
      ? [...state.history, outgoingQueueItemId]
      : state.history;
  return {
    ...state,
    bag: state.bag.filter((queueItemId) => queueItemId !== targetQueueItemId),
    history,
  };
}

/** Move backward through tracks actually played during this shuffle run. The
 * departed current track becomes the next forward pick, matching player history. */
export function popShuffleHistory(
  state: ShuffleState,
  playableQueueItemIds: readonly string[],
  currentQueueItemId: string | null,
  random: () => number = Math.random,
): ShuffleTarget {
  const synced = syncShuffleState(state, playableQueueItemIds, currentQueueItemId, random);
  const history = [...synced.history];
  let target: string | undefined;
  while (history.length > 0 && !target) {
    const candidate = history.pop();
    if (candidate && candidate !== currentQueueItemId) target = candidate;
  }
  if (!target) return { state: synced, queueItemId: null };

  const remainingBag = synced.bag.filter(
    (queueItemId) => queueItemId !== target && queueItemId !== currentQueueItemId,
  );
  return {
    state: {
      ...synced,
      bag:
        currentQueueItemId && synced.knownQueueItemIds.includes(currentQueueItemId)
          ? [currentQueueItemId, ...remainingBag]
          : remainingBag,
      history,
    },
    queueItemId: target,
  };
}

export function removeShuffleTrack(state: ShuffleState, queueItemId: string): ShuffleState {
  return {
    bag: state.bag.filter((id) => id !== queueItemId),
    history: state.history.filter((id) => id !== queueItemId),
    knownQueueItemIds: state.knownQueueItemIds.filter((id) => id !== queueItemId),
  };
}

function shuffle(values: readonly string[], random: () => number): string[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, random);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function randomIndex(length: number, random: () => number): number {
  if (length <= 1) return 0;
  const value = Math.min(1 - Number.EPSILON, Math.max(0, random()));
  return Math.floor(value * length);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
