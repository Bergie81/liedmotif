// The audio rig: the two decks and everything that makes sound.
//
// Owns the lazy Web Audio `PlayerEngine` and its interruption recovery, the
// buffer transport, each deck's source ladder, the output level, which Track
// each deck carries and which deck is active, and the disposal of all of it.
// It holds state and answers questions about it; every transport decision
// stays with the playback controller. Constructed once per controller; the
// host getters are read at call time.

import { bufferTransportEligible, sectionLoopEligible } from '@liedmotif/shared';
import { storedTrackAudio } from '@/lib/offline/device-offline';
import { PlayerEngine, type DeckId } from './audio-engine';
import { AudioResourceLifetime } from './audio-resource-lifetime';
import { adoptPrimedPlayerEngine } from './autoplay-arm';
import { BufferDecks, bufferTransportFlagEnabled } from './buffer-decks';
import { handleDeckEnded, type DeckLifecyclePorts } from './deck-lifecycle';
import { DeckSources } from './deck-sources';
import type { PlayableTrack } from './playable-track';
import type { PlaybackSample } from './playback-controller-api';

export interface DeckRigHost {
  /** The rendered deck element, or null before it mounts. */
  deckEl(deck: DeckId): HTMLAudioElement | null;
  /** Whether the user still wants playback (interruption recovery resumes then). */
  wantPlay(): boolean;
  /** The settled owner blend setting: false until the settings fetch settles. */
  blendSetting(): boolean;
  /** The Section loop's hook for a deck returning to its element. */
  onDeckEnteredElement(deck: DeckId): void;
  /** The deck lifecycle's ports, while bound: the buffer transport's natural
   * end mirrors the element `ended` through them. */
  lifecyclePorts(): DeckLifecyclePorts | null;
}

function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}

/** `navigator.deviceMemory` where the browser reports it. */
function reportedDeviceMemoryGb(): number | null {
  if (typeof navigator === 'undefined') return null;
  const { deviceMemory } = navigator as Navigator & { deviceMemory?: number };
  return typeof deviceMemory === 'number' ? deviceMemory : null;
}

export class DeckRig {
  activeDeck: DeckId = 'a';
  // The track each deck currently carries, so a deck that fires `ended` reports for
  // ITS OWN track — not the (already-swapped) active deck during a crossfade. A
  // PREPARED deck carries no track until the handoff commits.
  private readonly tracks: Record<DeckId, PlayableTrack | null> = { a: null, b: null };
  private engineInstance: PlayerEngine | null = null;
  // Each deck's pinned source-ladder walk (committed kind = source commit) —
  // owned by DeckSources; constructed once, reads elements live.
  private deckSources: DeckSources | null = null;
  // The buffer transport (decoded finals through AudioBufferSourceNodes).
  private bufferDecks: BufferDecks | null = null;
  // Unbind for the AudioContext interruption recovery (bound on engine attach).
  private recoveryUnbind: (() => void) | null = null;
  // The controller's whole output level (the cross-session handoff's fade
  // handle). A pending host arming behind an audible session mounts at 0.
  private outputVolume: number;
  readonly lifetime: AudioResourceLifetime;

  constructor(
    private readonly host: DeckRigHost,
    initialOutputVolume: number,
  ) {
    this.outputVolume = clampVolume(initialOutputVolume);
    this.lifetime = new AudioResourceLifetime(() => {
      this.deckSources?.dispose();
      this.bufferDecks?.dispose();
      this.bufferDecks = null;
      this.recoveryUnbind?.();
      this.recoveryUnbind = null;
      this.engineInstance?.dispose();
      this.engineInstance = null;
    });
  }

  el(deck: DeckId): HTMLAudioElement | null {
    return this.host.deckEl(deck);
  }

  /** The engine once a play gesture created it; null before. */
  engine(): PlayerEngine | null {
    return this.engineInstance;
  }

  // Create + attach the Web Audio graph exactly once, lazily, on the first play gesture.
  // Building it in a mount effect would double-run under React StrictMode and a second
  // `createMediaElementSource` on the same <audio> throws — leaving the element muted.
  // Deferring to the first gesture sidesteps that entirely.
  ensureEngine(): PlayerEngine | null {
    if (this.engineInstance) return this.engineInstance;
    const a = this.el('a');
    const b = this.el('b');
    if (!a || !b) return null;
    // A start-session gesture may have primed an engine (context created +
    // unlocked inside that click); adopt it so the poll-driven
    // auto-start rides its activation.
    const engine = adoptPrimedPlayerEngine() ?? new PlayerEngine();
    engine.attach(a, b);
    this.engineInstance = engine;
    // The graph carries the output level from here on; the elements return
    // to unity so the two paths never attenuate twice.
    this.applyOutputVolume();
    // Suspension/interruption recovery (phone call, route change, background
    // eviction): resume whenever the user still wants playback.
    this.recoveryUnbind = engine.bindInterruptionRecovery(() => this.host.wantPlay());
    return engine;
  }

  /** The buffer transport (constructed once, lazily). Its natural-end mirrors
   * the element `ended` semantics through the shared lifecycle handler. */
  buffers(): BufferDecks {
    this.bufferDecks ??= new BufferDecks(
      () => this.engineInstance,
      (deck, positionSeconds) => {
        const ports = this.host.lifecyclePorts();
        if (ports) handleDeckEnded(ports, deck, positionSeconds);
      },
      storedTrackAudio,
    );
    return this.bufferDecks;
  }

  sources(): DeckSources {
    this.deckSources ??= new DeckSources((deck) => this.el(deck), storedTrackAudio);
    return this.deckSources;
  }

  deckTrack(deck: DeckId): PlayableTrack | null {
    return this.tracks[deck];
  }

  /** Record the track `deck` carries; null when it carries none. */
  carry(deck: DeckId, track: PlayableTrack | null): void {
    this.tracks[deck] = track;
  }

  /** The track the active deck is actually carrying — the audible source of truth
   * every current-track action/report targets (the queue cursor is only
   * navigation and can lag a poll that dropped the active item). */
  activeTrack(): PlayableTrack | null {
    return this.tracks[this.activeDeck];
  }

  /** The held output level. */
  outputLevel(): number {
    return this.outputVolume;
  }

  /** Apply the held output level: through the master bus gain when a graph
   * exists (elements then stay at unity — their samples route through it),
   * through element volume on the sequential fallback. */
  applyOutputVolume(): void {
    const volume = this.outputVolume;
    const graphApplied = this.engineInstance?.setMasterGain(volume) ?? false;
    for (const deck of ['a', 'b'] as const) {
      const el = this.el(deck);
      if (el) el.volume = graphApplied ? 1 : volume;
    }
  }

  setOutputVolume(volume: number): void {
    const clamped = clampVolume(volume);
    if (this.outputVolume === clamped) return;
    this.outputVolume = clamped;
    this.applyOutputVolume();
  }

  /** Whether the live blend runs at all: a real graph AND the settled owner
   * setting. When false the player is strictly sequential — advance on `ended`,
   * one audible deck, never an early-started incoming element. */
  blendActive(): boolean {
    return Boolean(this.engineInstance?.isActive) && this.host.blendSetting();
  }

  /** Session-level buffer-transport qualification:
   * the internal flag, a decodable context, and `navigator.deviceMemory ≥ 4` —
   * a missing API is safe-off (element decks, no UA sniffing). */
  bufferEligible(): boolean {
    return (
      this.blendActive() &&
      bufferTransportEligible({
        flagEnabled: bufferTransportFlagEnabled(),
        decodeSupported: this.buffers().supported(),
        deviceMemoryGb: reportedDeviceMemoryGb(),
      })
    );
  }

  deviceAllowsSectionLoop(): boolean {
    return sectionLoopEligible({
      flagEnabled: bufferTransportFlagEnabled(),
      decodeSupported: this.buffers().supported(),
      deviceMemoryGb: reportedDeviceMemoryGb(),
    });
  }

  /** The deck's truthful playback sample — the buffer transport's exact
   * context-clock view while it carries the deck, the element's otherwise.
   * One boundary for every consumer (reports, Media Session, Back threshold),
   * so no caller can mix the two clocks. */
  sample(deck: DeckId): PlaybackSample {
    const buffers = this.buffers();
    if (buffers.carrying(deck)) {
      return {
        positionSeconds: buffers.positionSeconds(deck),
        durationSeconds: buffers.durationSeconds(deck),
        playbackRate: buffers.playbackRate(deck),
      };
    }
    const el = this.el(deck);
    return {
      positionSeconds: el?.currentTime ?? null,
      durationSeconds: el && Number.isFinite(el.duration) ? el.duration : null,
      playbackRate: el?.playbackRate ?? 1,
    };
  }

  position(deck: DeckId): number | null {
    return this.sample(deck).positionSeconds;
  }

  /** Best-effort re-sync of the deck's muted carrier element to its buffer
   * clock (focus/lock-screen truth — the audible audio is the buffer either
   * way). Shared by buffer resume, the carrier watchdog, and the seek funnel. */
  syncCarrier(deck: DeckId): void {
    const el = this.el(deck);
    const position = this.buffers().positionSeconds(deck);
    if (el && position != null && Number.isFinite(el.duration)) {
      el.currentTime = Math.min(position, el.duration);
    }
  }

  /** Return a deck to the element path before (re)loading it: any buffer
   * playback stops deliberately and the media gate reopens. */
  enterElementMode(deck: DeckId): void {
    this.host.onDeckEnteredElement(deck);
    this.buffers().stop(deck);
    this.engineInstance?.setDeckMediaAudible(deck, true);
  }

  /** Stop + unload a deck (buffer source, gate, element, ladder, track ref). */
  unload(deck: DeckId): void {
    this.enterElementMode(deck);
    this.sources().unload(deck);
    this.tracks[deck] = null;
  }
}
