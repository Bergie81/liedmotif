'use client';

// The Section loop's coordination: the Loop a Part tool's state, moving the
// audible Track onto a repeating buffer, and ending the loop. The audio thread
// does the repeating (`BufferDecks.setLoop`), so it needs no timer and has no
// element fallback: a Track loops only once its final is decoded, and otherwise
// the tool says so. The controller supplies its playback surface through
// `depsRef`, assigned every render and read only at event time.

import { useCallback, useRef, type RefObject } from 'react';
import { WAVEFORM_BAR_COUNT, type BufferLoopRegion } from '@liedmotif/shared';
import type { DeckId } from './audio-engine';
import type { BufferDecks } from './buffer-decks';
import type { PlayableTrack } from './playable-track';
import { CLOSED_SECTION_LOOP_TOOL, type SectionLoopTool } from './playback-controller-api';
import type { LoopQueueSnapshot } from './use-repeat-one';

const LOOP_FAILED_NOTICE = 'That part couldn’t loop, so the Track carried on from there.';

/** What an open tool has prepared: a final that lands prepares the Track again. */
function preparationKey(queueItemId: string, finalPath: string | null): string {
  return `${queueItemId}:${finalPath}`;
}

export interface SectionLoopDeps {
  activeDeck(): DeckId;
  activeTrack(): PlayableTrack | null;
  deckEl(deck: DeckId): HTMLAudioElement | null;
  buffers(): BufferDecks;
  /** Whether this device may run a Section loop at all. */
  deviceAllows(): boolean;
  /** Close the element's path to the output: the buffer is audible from here. */
  muteElement(deck: DeckId): void;
  /** Cancel an armed edge and settle a running fade, as a seek does. */
  abandonEdge(): void;
  /** The buffer refused: carry on from `seconds` on the element, unlooped. */
  carryOnOnElement(deck: DeckId, seconds: number): void;
  syncCarrier(deck: DeckId): void;
  /** Re-sync the prepared deck to the next target, which a loop empties. */
  syncPreparedTarget(): void;
  /** Hold automatic generation while a loop is live. */
  holdGeneration(held: boolean): void;
  /** Report and republish a position the listener just moved to. */
  positionMoved(track: PlayableTrack, seconds: number): void;
  patch(next: { sectionLoopTool: SectionLoopTool }): void;
  notice(message: string): void;
}

/** Every function here is referentially stable, so the deck-lifecycle effect may
 *  depend on them without re-running (its cleanup disposes the audio engine). */
export interface SectionLoopApi {
  /** The live loop, or null. */
  region(): BufferLoopRegion | null;
  toggleTool(): void;
  setRegion(region: BufferLoopRegion, fromSeconds: number): void;
  clearRegion(): void;
  /** The audible Track or its final changed: an open tool prepares it. */
  onTrackChanged(queueItemId: string | null, finalPath: string | null): void;
  /** A deck went back to its element, the one path every Track change takes. */
  onDeckEnteredElement(deck: DeckId): void;
  /** A hold would block a Change Vibe's fill, so the listener's newer ask wins. */
  onQueueSnapshot(snapshot: LoopQueueSnapshot): void;
}

export function useSectionLoop(depsRef: RefObject<SectionLoopDeps | null>): SectionLoopApi {
  const toolRef = useRef<SectionLoopTool>(CLOSED_SECTION_LOOP_TOOL);
  // Bumped per preparation, so a slow decode cannot land on a later Track.
  const preparationRef = useRef(0);
  const preparedForRef = useRef<string | null>(null);

  const setTool = useCallback(
    (next: SectionLoopTool) => {
      toolRef.current = next;
      depsRef.current?.patch({ sectionLoopTool: next });
    },
    [depsRef],
  );

  const region = useCallback(
    (): BufferLoopRegion | null =>
      toolRef.current.phase === 'ready' ? toolRef.current.region : null,
    [],
  );

  const forgetRegion = useCallback(
    (deck: DeckId) => {
      const el = depsRef.current?.deckEl(deck);
      if (el) el.loop = false;
      const tool = toolRef.current;
      if (tool.phase === 'ready') setTool({ ...tool, region: null });
      depsRef.current?.holdGeneration(false);
    },
    [depsRef, setTool],
  );

  const clearRegion = useCallback(() => {
    const deps = depsRef.current;
    if (!deps || !region()) return;
    const deck = deps.activeDeck();
    deps.buffers().clearLoop(deck);
    forgetRegion(deck);
    deps.syncCarrier(deck);
    deps.syncPreparedTarget();
  }, [depsRef, forgetRegion, region]);

  const prepare = useCallback(() => {
    const deps = depsRef.current;
    if (!deps) return;
    // The tool is about to drop the region, so the audio must not keep repeating it.
    clearRegion();
    const preparation = (preparationRef.current += 1);
    const track = deps.activeTrack();
    preparedForRef.current = track ? preparationKey(track.queueItemId, track.assets.final) : null;
    if (!track) {
      setTool({ phase: 'unavailable' });
      return;
    }
    setTool({ phase: 'preparing' });
    const buffers = deps.buffers();
    void buffers.ensureDecoded(track).then((decoded) => {
      if (preparationRef.current !== preparation) return;
      const waveform = decoded ? buffers.waveform(track.trackId, WAVEFORM_BAR_COUNT) : null;
      setTool(waveform ? { phase: 'ready', ...waveform, region: null } : { phase: 'unavailable' });
    });
  }, [clearRegion, depsRef, setTool]);

  const toggleTool = useCallback(() => {
    const deps = depsRef.current;
    if (!deps) return;
    if (toolRef.current.phase !== 'closed') {
      clearRegion();
      preparationRef.current += 1;
      preparedForRef.current = null;
      setTool(CLOSED_SECTION_LOOP_TOOL);
      return;
    }
    if (deps.deviceAllows()) prepare();
  }, [clearRegion, depsRef, prepare, setTool]);

  const setRegion = useCallback(
    (next: BufferLoopRegion, fromSeconds: number) => {
      const deps = depsRef.current;
      const tool = toolRef.current;
      if (!deps || tool.phase !== 'ready') return;
      const deck = deps.activeDeck();
      const track = deps.activeTrack();
      const el = deps.deckEl(deck);
      if (!track || !el) return;
      deps.abandonEdge();

      const buffers = deps.buffers();
      const wasPlaying = !el.paused;
      // A deck on its element lands on the buffer paused, takes the region, then
      // starts: one source, never a brief unlooped one in between.
      const entering = !buffers.carrying(deck);
      const parked = !entering || buffers.parkAt(deck, track.trackId, fromSeconds);
      if (entering && parked) deps.muteElement(deck);
      const looped =
        parked &&
        buffers.setLoop(deck, next, fromSeconds) &&
        (!entering || !wasPlaying || buffers.resume(deck));
      if (!looped) {
        deps.carryOnOnElement(deck, fromSeconds);
        deps.notice(LOOP_FAILED_NOTICE);
        return;
      }

      el.loop = true;
      deps.syncCarrier(deck);
      setTool({ ...tool, region: next });
      deps.holdGeneration(true);
      deps.syncPreparedTarget();
      deps.positionMoved(track, fromSeconds);
    },
    [depsRef, setTool],
  );

  const onTrackChanged = useCallback(
    (queueItemId: string | null, finalPath: string | null) => {
      if (toolRef.current.phase === 'closed' || !queueItemId) return;
      if (preparedForRef.current !== preparationKey(queueItemId, finalPath)) prepare();
    },
    [prepare],
  );

  const onDeckEnteredElement = useCallback(
    (deck: DeckId) => {
      const deps = depsRef.current;
      if (!deps || !region() || deck !== deps.activeDeck()) return;
      forgetRegion(deck);
    },
    [depsRef, forgetRegion, region],
  );

  const onQueueSnapshot = useCallback(
    ({ revisionMoved, sessionStatus, queueItemIds }: LoopQueueSnapshot) => {
      const deps = depsRef.current;
      if (!deps || !region()) return;
      const audible = deps.activeTrack()?.queueItemId;
      const loopVanished = audible != null && !queueItemIds.has(audible);
      if (revisionMoved || loopVanished || sessionStatus !== 'active') clearRegion();
    },
    [clearRegion, depsRef, region],
  );

  return {
    region,
    toggleTool,
    setRegion,
    clearRegion,
    onTrackChanged,
    onDeckEnteredElement,
    onQueueSnapshot,
  };
}
