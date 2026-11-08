// The buffer-deck transport driver (beat-locked tier).
//
// Owns the decoded-final cache and each deck's `AudioBufferSourceNode`
// playback: decode of pinned final bytes (never an unpinned URL) or the
// device's stored copy of them, one-shot sources recreated per start,
// pause/resume as stop-record-offset-recreate, deliberate stop vs natural
// `onended` (generation-guarded against stale events), and exact position
// bookkeeping against the AudioContext clock. All state DECISIONS go through
// the pure `bufferDeckTransition` table; this class executes the returned
// actions against the Web Audio graph.
//
// Retention: `retainOnly` holds at most the current + next decoded buffers
// (release on advance) — a playing source keeps its own buffer reference, so
// dropping a cache entry never interrupts audio.

import {
  bufferDeckTransition,
  bufferPositionSeconds,
  clamp,
  type BufferDeckAction,
  type BufferDeckEvent,
  type BufferDeckState,
  type BufferLoopRegion,
  type BufferPlaybackClock,
  waveformBars,
} from '@liedmotif/shared';
import type { DeckId, PlayerEngine } from './audio-engine';

/** localStorage key of the internal buffer-transport A/B switch. */
export const BUFFER_TRANSPORT_FLAG_STORAGE_KEY = 'liedmotif.buffer-transport';

/**
 * The internal A/B flag — ships ON (never a
 * silent flag-off). The single legitimate off-switch is the on-device
 * checklist setting localStorage to `'off'` for side-by-side comparison.
 */
export function bufferTransportFlagEnabled(): boolean {
  try {
    return (
      typeof localStorage === 'undefined' ||
      localStorage.getItem(BUFFER_TRANSPORT_FLAG_STORAGE_KEY) !== 'off'
    );
  } catch {
    return true;
  }
}

/** The pinned-asset slice of a track the decode cache needs. */
export interface DecodableTrack {
  trackId: string;
  assets: { final: string | null; stream: string | null };
}

interface DeckPlayback {
  trackId: string;
  buffer: AudioBuffer;
  state: BufferDeckState;
  source: AudioBufferSourceNode | null;
  /** Valid while `playing` — everything position derives from. */
  clock: BufferPlaybackClock;
  /** The recorded position while `paused`. */
  offsetSeconds: number;
  /** Bumped per created source; a stale source's `onended` must never count. */
  generation: number;
}

interface DecodeEntry {
  promise: Promise<AudioBuffer | null>;
  buffer: AudioBuffer | null;
  /** Aborts the FETCH stage of a stale decode (queue replacement). The decode
   *  stage itself is not abortable by spec; its result is discarded instead. */
  abort: AbortController | null;
  /** An in-flight entry dropped by `retainOnly` stays in the cache as a
   *  TOMBSTONE until it settles (an uncancellable `decodeAudioData` must never
   *  overlap a retry for the same track): a re-request simply un-evicts it. */
  evicted: boolean;
}

export class BufferDecks {
  /** Decoded finals by track id; entries hold the in-flight promise so
   *  concurrent `ensureDecoded` calls share one fetch+decode. */
  private cache = new Map<string, DecodeEntry>();
  private playback: Record<DeckId, DeckPlayback | null> = { a: null, b: null };

  constructor(
    private readonly engine: () => PlayerEngine | null,
    /** A source ran out NATURALLY while its deck was playing (report + advance).
     *  `positionSeconds` is the final buffer position (the decoded duration) —
     *  the truthful context-clock report position, never the carrier's. */
    private readonly onNaturalEnd: (deck: DeckId, positionSeconds: number) => void,
    /** The device's stored copy of a Track — the same final bytes, read
     *  without a request — or null. */
    private readonly storedAudio: (trackId: string) => Blob | null = () => null,
  ) {}

  /** Whether decode + buffer playback are available at all (gate input). */
  supported(): boolean {
    const ctx = this.engine()?.context();
    return ctx != null && typeof ctx.decodeAudioData === 'function';
  }

  /**
   * Decode the track's pinned FINAL bytes (buffer decks only ever decode
   * pinned `?asset=final` bytes or the device's stored copy of
   * them). True when a decoded buffer is cached. Failures are NOT cached — a
   * final that 404s now (download pending) may exist by the next edge.
   */
  ensureDecoded(track: DecodableTrack): Promise<boolean> {
    const existing = this.cache.get(track.trackId);
    if (existing) {
      if (!existing.evicted) {
        return existing.promise.then(() => this.isDecoded(track.trackId));
      }
      // Re-requesting a TOMBSTONE reuses its in-flight work — two decodes of
      // the same near-200 MB final must never overlap. But the tombstone's
      // fetch stage was already aborted; if that kills the attempt, retry
      // ONCE after it settles (nothing is in flight by then).
      existing.evicted = false;
      return existing.promise.then((buffer) => {
        if (buffer != null) return this.isDecoded(track.trackId);
        this.evict(track.trackId, existing);
        return this.ensureDecoded(track);
      });
    }
    const ctx = this.engine()?.context();
    const stored = this.storedAudio(track.trackId);
    const url = track.assets.final;
    if (!ctx || typeof ctx.decodeAudioData !== 'function' || (!stored && !url)) {
      return Promise.resolve(false);
    }
    const abort = url && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const entry: DecodeEntry = {
      buffer: null,
      abort,
      evicted: false,
      promise: Promise.resolve(null),
    };
    const fetchFinal = (): Promise<ArrayBuffer | null> =>
      url
        ? fetch(url, abort ? { signal: abort.signal } : undefined).then((res) =>
            res.ok ? res.arrayBuffer() : null,
          )
        : Promise.resolve(null);
    // A stored copy that will not read falls back to the pinned final, as a
    // deck's ladder steps down from it.
    const read = stored ? stored.arrayBuffer().catch(fetchFinal) : fetchFinal();
    entry.promise = read
      .then((bytes) => (bytes ? ctx.decodeAudioData(bytes) : null))
      .then(
        (buffer) => {
          entry.abort = null;
          // A decode settling for a superseded or still-evicted entry stays
          // discarded: the cache is only written when the entry is live.
          if (buffer == null || this.cache.get(track.trackId) !== entry || entry.evicted) {
            this.evict(track.trackId, entry);
            return null;
          }
          entry.buffer = buffer;
          return buffer;
        },
        () => {
          entry.abort = null;
          this.evict(track.trackId, entry);
          return null;
        },
      );
    this.cache.set(track.trackId, entry);
    return entry.promise.then(() => this.isDecoded(track.trackId));
  }

  isDecoded(trackId: string): boolean {
    return this.cache.get(trackId)?.buffer != null;
  }

  /** Drop every decode entry not in `trackIds` (hold at most current + next;
   *  a playing source keeps its own buffer reference, so this never cuts
   *  audio). Dropped in-flight decodes ABORT their fetch stage and remain as
   *  settle-gated tombstones (stale-decode cancellation on queue
   *  replacement — an uncancellable `decodeAudioData` must never overlap a
   *  retry for the same track). */
  retainOnly(trackIds: Array<string | null | undefined>): void {
    const keep = new Set(trackIds.filter((id): id is string => id != null));
    for (const [id, entry] of this.cache) {
      if (keep.has(id)) continue;
      entry.abort?.abort();
      if (entry.buffer != null) this.cache.delete(id);
      else entry.evicted = true;
    }
  }

  /**
   * Start `trackId` on `deck` sample-accurately: a fresh one-shot source into
   * the deck's chain, `start(when, offset)` on the context clock at the locked
   * rate. False when the buffer is not decoded or the graph refuses — the
   * caller falls back to the element deck, uninterrupted.
   */
  startAtTime(
    deck: DeckId,
    trackId: string,
    whenContextTime: number,
    offsetSeconds: number,
    playbackRate: number,
  ): boolean {
    const buffer = this.cache.get(trackId)?.buffer;
    if (!buffer) return false;
    const playback = this.replacePlayback(deck, trackId, buffer, {
      startContextTime: whenContextTime,
      startOffsetSeconds: offsetSeconds,
      playbackRate,
    });
    if (!this.apply(deck, playback, 'start')) {
      this.playback[deck] = null;
      return false;
    }
    return true;
  }

  /** Carry a decoded Track paused at `offsetSeconds`, with no source yet: a
   *  later `resume` starts it. False when the buffer is not decoded. */
  parkAt(deck: DeckId, trackId: string, offsetSeconds: number): boolean {
    const buffer = this.cache.get(trackId)?.buffer;
    if (!buffer) return false;
    const playback = this.replacePlayback(deck, trackId, buffer, {
      startContextTime: 0,
      startOffsetSeconds: clamp(offsetSeconds, 0, buffer.duration),
      playbackRate: 1,
    });
    this.apply(deck, playback, 'park');
    return true;
  }

  /** The decoded Track's waveform and true length, or null until it is decoded. */
  waveform(trackId: string, barCount: number): { bars: number[]; durationSeconds: number } | null {
    const buffer = this.cache.get(trackId)?.buffer;
    if (!buffer) return null;
    return {
      bars: waveformBars(buffer.getChannelData(0), barCount),
      durationSeconds: buffer.duration,
    };
  }

  /** Pause: record the exact context-clock position, stop the one-shot node. */
  pause(deck: DeckId): void {
    const playback = this.playback[deck];
    if (!playback) return;
    const position = this.positionSeconds(deck);
    if (position != null) playback.offsetSeconds = position;
    this.apply(deck, playback, 'pause');
  }

  /** Resume from the recorded offset on a recreated source. A failed source
   *  recreation rolls the transport back to `paused` (the recorded offset
   *  survives for the caller's element-path fallback). */
  resume(deck: DeckId): boolean {
    const playback = this.playback[deck];
    if (!playback || playback.state !== 'paused') return false;
    const ctx = this.engine()?.context();
    if (!ctx) return false;
    playback.clock = {
      startContextTime: ctx.currentTime,
      startOffsetSeconds: playback.offsetSeconds,
      playbackRate: playback.clock.playbackRate,
      loop: playback.clock.loop,
    };
    if (!this.apply(deck, playback, 'resume')) {
      playback.state = 'paused';
      playback.source = null;
      return false;
    }
    return true;
  }

  /** Seek: reposition a playing or paused deck
   *  — pause → overwrite the recorded offset → resume, the same
   *  stop-record-offset-recreate operation pause/resume already are (the
   *  resume is skipped while paused: the rewritten offset is the seek). The
   *  target clamps to `[0, buffer.duration]` against the decoded truth —
   *  transport-level self-defense, independent of the caller's validation.
   *  False when the deck carries nothing, the target is non-finite (`clamp`
   *  passes `NaN` through — rejected before any side effect), or the
   *  playing-path source recreation fails — then the deck sits `paused` with
   *  the TARGET offset recorded (`resume()`'s failure contract; the caller
   *  falls back to the element path at the sought position). */
  seekTo(deck: DeckId, seconds: number): boolean {
    const playback = this.playback[deck];
    if (!playback || !Number.isFinite(seconds)) return false;
    const wasPlaying = playback.state === 'playing';
    if (wasPlaying) this.pause(deck);
    playback.offsetSeconds = clamp(seconds, 0, playback.buffer.duration);
    return wasPlaying ? this.resume(deck) : true;
  }

  /** Repeat `region` from `fromSeconds`, which must sit before its end: a source
   *  started past the end never enters the loop. Always through a recreated
   *  source, for the same reason. The failure contract is `seekTo`'s, with no
   *  region. */
  setLoop(deck: DeckId, region: BufferLoopRegion, fromSeconds: number): boolean {
    const playback = this.playback[deck];
    if (!playback || !Number.isFinite(fromSeconds)) return false;
    const { sampleRate } = playback.buffer;
    const onFrame = (seconds: number) => Math.round(seconds * sampleRate) / sampleRate;
    const loop = {
      startSeconds: onFrame(region.startSeconds),
      endSeconds: onFrame(region.endSeconds),
    };
    if (!(loop.endSeconds > loop.startSeconds) || fromSeconds >= loop.endSeconds) return false;
    const wasPlaying = playback.state === 'playing';
    if (wasPlaying) this.pause(deck);
    playback.offsetSeconds = clamp(fromSeconds, 0, playback.buffer.duration);
    playback.clock = { ...playback.clock, loop };
    if (!wasPlaying || this.resume(deck)) return true;
    playback.clock = { ...playback.clock, loop: undefined };
    return false;
  }

  /** Stop repeating: the running source plays on past the region untouched, so
   *  the audio never breaks and its natural end counts again. */
  clearLoop(deck: DeckId): void {
    const playback = this.playback[deck];
    if (!playback?.clock.loop) return;
    const position = this.positionSeconds(deck);
    const now = this.engine()?.context()?.currentTime;
    if (playback.source) playback.source.loop = false;
    playback.clock =
      position != null && now != null
        ? {
            startContextTime: now,
            startOffsetSeconds: position,
            playbackRate: playback.clock.playbackRate,
          }
        : { ...playback.clock, loop: undefined };
  }

  /** Deliberate stop (navigation, unload, cancellation): never a natural end. */
  stop(deck: DeckId): void {
    const playback = this.playback[deck];
    if (!playback) return;
    this.apply(deck, playback, 'stop');
    this.playback[deck] = null;
  }

  /** Whether the deck is playing or paused from a decoded buffer. */
  carrying(deck: DeckId): boolean {
    return this.playback[deck] != null;
  }

  state(deck: DeckId): BufferDeckState {
    return this.playback[deck]?.state ?? 'idle';
  }

  trackId(deck: DeckId): string | null {
    return this.playback[deck]?.trackId ?? null;
  }

  playbackRate(deck: DeckId): number {
    return this.playback[deck]?.clock.playbackRate ?? 1;
  }

  durationSeconds(deck: DeckId): number | null {
    return this.playback[deck]?.buffer.duration ?? null;
  }

  /** The exact context-clock position of the deck's buffer, or null when it
   *  carries none (position bookkeeping + reports against the context clock). */
  positionSeconds(deck: DeckId): number | null {
    const playback = this.playback[deck];
    if (!playback) return null;
    if (playback.state !== 'playing') return playback.offsetSeconds;
    const now = this.engine()?.context()?.currentTime;
    if (now == null) return playback.offsetSeconds;
    return bufferPositionSeconds(playback.clock, now, playback.buffer.duration);
  }

  /** Stop and forget both decks and every cached decode (unmount). */
  dispose(): void {
    this.stop('a');
    this.stop('b');
    for (const entry of this.cache.values()) entry.abort?.abort();
    this.cache.clear();
  }

  // --- internals -----------------------------------------------------------

  /** Stop whatever the deck carries and put an idle playback of `buffer` on it. */
  private replacePlayback(
    deck: DeckId,
    trackId: string,
    buffer: AudioBuffer,
    clock: BufferPlaybackClock,
  ): DeckPlayback {
    if (this.playback[deck]) this.stop(deck);
    const playback: DeckPlayback = {
      trackId,
      buffer,
      state: 'idle',
      source: null,
      clock,
      offsetSeconds: clock.startOffsetSeconds,
      generation: 0,
    };
    this.playback[deck] = playback;
    return playback;
  }

  /** Drop a cache entry, but only if it still belongs to this attempt (a retry
   *  may have replaced it while the failing promise settled). */
  private evict(trackId: string, entry: { buffer: AudioBuffer | null }): void {
    if (this.cache.get(trackId) === entry) this.cache.delete(trackId);
  }

  /** Run one event through the pure table and execute the returned action. */
  private apply(deck: DeckId, playback: DeckPlayback, event: BufferDeckEvent): boolean {
    const next = bufferDeckTransition(playback.state, event);
    playback.state = next.state;
    const ok = this.runAction(deck, playback, next.action);
    if (next.naturalEnd) {
      this.playback[deck] = null;
      // A natural end means the source rendered its whole buffer: the final
      // position IS the decoded duration (context-clock truth, never the
      // muted carrier element's stale time).
      this.onNaturalEnd(deck, playback.buffer.duration);
    }
    return ok;
  }

  private runAction(deck: DeckId, playback: DeckPlayback, action: BufferDeckAction): boolean {
    if (action === 'stop-source') {
      // The state already moved off `playing` and the generation advances, so
      // this node's late `onended` is provably stale.
      playback.generation += 1;
      try {
        playback.source?.stop();
      } catch {
        // Already stopped/never started — nothing to unwind.
      }
      playback.source = null;
      return true;
    }
    if (action === 'start-source') {
      const engine = this.engine();
      const ctx = engine?.context();
      const input = engine?.deckInput(deck);
      if (!ctx || !input) return false;
      playback.generation += 1;
      const generation = playback.generation;
      try {
        const source = ctx.createBufferSource();
        source.buffer = playback.buffer;
        source.playbackRate.value = playback.clock.playbackRate;
        const { loop } = playback.clock;
        if (loop) {
          source.loop = true;
          source.loopStart = loop.startSeconds;
          source.loopEnd = loop.endSeconds;
        }
        source.connect(input);
        source.onended = () => {
          const current = this.playback[deck];
          if (current !== playback || playback.generation !== generation) return;
          this.apply(deck, playback, 'source-ended');
        };
        source.start(playback.clock.startContextTime, playback.clock.startOffsetSeconds);
        playback.source = source;
        return true;
      } catch {
        playback.source = null;
        return false;
      }
    }
    return true;
  }
}
