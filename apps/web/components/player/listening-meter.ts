// Measures how long the current Track was actually heard, for personal analytics.
// One occurrence per Track start: pause, seek and resume continue it,
// a new start — another Track or a replay of this one — opens the next.
//
// Time is wall-clock time observed while audio audibly advanced, never a media
// position: a seek moves the position and earns nothing. It measures what the
// app plays — not the speaker behind it, nor anyone's attention.
//
// Pure bookkeeping over an injected clock and sender: it never touches the
// transport, and a sender that throws costs a report, never playback.

import type {
  ListeningEndReason,
  ListeningOrigin,
  ListeningSurface,
  ReportListeningRequest,
} from '@liedmotif/shared';

export type ListeningReport = ReportListeningRequest;

/** Unsaved listening that triggers a progress save. */
const SAVE_EVERY_MS = 10_000;
/**
 * The longest stretch between two observations still credited. Observations come
 * about once a second; a far longer gap means the page was suspended, and what
 * happened inside it is unknown.
 */
const MAX_CREDITED_GAP_MS = 5_000;

export interface ListeningTarget {
  trackId: string;
  /** The Session whose Queue is playing; null on a Playlist or preview. */
  sessionId: string | null;
  surface: ListeningSurface;
}

/**
 * "Is audio audibly advancing?", asked once per observation by every surface.
 * `audible` is the app's own knowledge only — its mute and its volume — never
 * the device's speaker state.
 */
export function createAudibleAdvanceProbe(
  read: () => { position: number | null; audible: boolean },
): () => boolean {
  let lastPosition: number | null = null;
  return () => {
    const { position, audible } = read();
    const moved = position !== null && position !== lastPosition;
    lastPosition = position;
    return moved && audible;
  };
}

export interface ListeningStart {
  /** A deliberate act, or the Queue moving by itself (the default). */
  origin?: Exclude<ListeningOrigin, 'loop'>;
  /**
   * Length of the crossfade this start opens: the previous Track keeps sounding
   * under this one for that long. It stays open as the fading tail until
   * `close` names it, but shares credit only for the fade's length — a tail
   * whose ending never arrives must not halve its successor's credit for good.
   */
  overlapMs?: number;
}

export interface ListeningMeter {
  /** A Track start: always a new occurrence, a replay of the open Track included. */
  begin(target: ListeningTarget, start?: ListeningStart): void;
  /**
   * Audio started moving, from a surface that cannot tell a start from a resume
   * (a media element's `play`). Continues the open occurrence of the same Track,
   * so a repeated or wrapper-duplicated callback never manufactures a play.
   */
  resume(target: ListeningTarget): void;
  /**
   * Call regularly while a Track is loaded; `advancing` = playback is moving AND
   * the app is letting it be heard (not app-muted, not at zero volume).
   */
  observe(advancing: boolean): void;
  /**
   * This Track's playback is over. Names the Track because during a crossfade
   * two are open and the ending belongs to one; an ending for a Track with no
   * open occurrence — a duplicate callback — is ignored.
   */
  close(trackId: string, reason: ListeningEndReason): void;
  /** Save unsaved progress now: the page may not get another chance. */
  flush(): void;
  /** The surface is going away: every open occurrence ends. */
  end(reason: ListeningEndReason): void;
}

interface Occurrence extends ListeningTarget {
  occurrenceId: string;
  origin: ListeningOrigin;
  startedAt: number;
  /** Credit: overlap is divided, so one meter's credits sum to its elapsed listening. */
  listenedMs: number;
  /** What this Track itself played, overlap undivided — the play threshold's measure. */
  playedMs: number;
  savedPlayedMs: number;
}

export function createListeningMeter(deps: {
  send: (report: ListeningReport) => void;
  now: () => number;
  newOccurrenceId: () => string;
}): ListeningMeter {
  let current: Occurrence | null = null;
  /** The previous Track's tail, still sounding under `current` during a crossfade. */
  let fading: Occurrence | null = null;
  /** Played time the tail may still share. */
  let fadeLeftMs = 0;
  let lastTrackId: string | null = null;
  let lastObservedAt: number | null = null;
  let wasAdvancing = false;

  function save(occurrence: Occurrence, endReason: ListeningEndReason | null) {
    if (occurrence.playedMs === 0) return;
    if (endReason === null && occurrence.playedMs === occurrence.savedPlayedMs) return;
    occurrence.savedPlayedMs = occurrence.playedMs;
    try {
      deps.send({
        occurrenceId: occurrence.occurrenceId,
        trackId: occurrence.trackId,
        sessionId: occurrence.sessionId,
        surface: occurrence.surface,
        origin: occurrence.origin,
        startedAt: new Date(occurrence.startedAt).toISOString(),
        listenedMs: Math.round(occurrence.listenedMs),
        playedMs: Math.round(occurrence.playedMs),
        clientTimestamp: new Date(deps.now()).toISOString(),
        endReason,
      });
    } catch {
      // Best-effort by contract.
    }
  }

  function credit(advancing: boolean) {
    const now = deps.now();
    if (wasAdvancing && lastObservedAt !== null) {
      const elapsed = now - lastObservedAt;
      if (elapsed > 0 && elapsed <= MAX_CREDITED_GAP_MS) {
        const shared = fading && current ? Math.min(elapsed, fadeLeftMs) : 0;
        const solo = current ?? fading;
        if (fading && current) {
          fading.playedMs += shared;
          fading.listenedMs += shared / 2;
          fadeLeftMs -= shared;
        }
        if (solo) {
          solo.playedMs += elapsed;
          solo.listenedMs += elapsed - shared / 2;
        }
      }
    }
    lastObservedAt = now;
    wasAdvancing = advancing;
  }

  /** Callers credit up to now first. */
  function finish(occurrence: Occurrence, reason: ListeningEndReason) {
    save(occurrence, reason);
    if (fading === occurrence) fading = null;
    else current = null;
  }

  function end(reason: ListeningEndReason) {
    credit(false);
    if (fading) finish(fading, reason);
    if (current) finish(current, reason);
  }

  function begin(target: ListeningTarget, start: ListeningStart = {}) {
    credit(wasAdvancing);
    if (fading) finish(fading, 'replaced');
    const overlapMs = start.overlapMs ?? 0;
    if (current && overlapMs > 0) {
      fading = current;
      fadeLeftMs = overlapMs;
    } else if (current) finish(current, 'replaced');
    const origin = start.origin ?? 'auto';
    const startedAt = deps.now();
    current = {
      occurrenceId: deps.newOccurrenceId(),
      ...target,
      // The same Track coming round with nobody asking is a loop, whichever
      // mechanism (Loop Track, a one-Track Queue, Repeat) brought it back.
      origin: origin === 'auto' && lastTrackId === target.trackId ? 'loop' : origin,
      startedAt,
      listenedMs: 0,
      playedMs: 0,
      savedPlayedMs: 0,
    };
    lastTrackId = target.trackId;
    lastObservedAt = startedAt;
    wasAdvancing = true;
  }

  return {
    begin,
    resume(target) {
      if (current?.trackId === target.trackId && current.surface === target.surface) credit(true);
      else begin(target, { origin: 'user' });
    },
    observe(advancing) {
      const stopping = wasAdvancing && !advancing;
      credit(advancing);
      for (const occurrence of [fading, current]) {
        if (!occurrence) continue;
        // A pause may be the last thing this page ever does, so it saves at once.
        if (stopping || occurrence.playedMs - occurrence.savedPlayedMs >= SAVE_EVERY_MS)
          save(occurrence, null);
      }
    },
    close(trackId, reason) {
      credit(wasAdvancing);
      const occurrence = [fading, current].find((o) => o?.trackId === trackId);
      if (occurrence) finish(occurrence, reason);
    },
    flush() {
      credit(wasAdvancing);
      if (fading) save(fading, null);
      if (current) save(current, null);
    },
    end,
  };
}
