'use client';

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { DragAxis } from '@/components/ui/drag-axis';
import type { CoverPeek, SwipeNeighbors } from './player-presentation';

const SWIPE_DISTANCE_PX = 72;
/** Movement below this is still a tap, so the Lyrics tab stays clickable. */
const TAP_SLOP_PX = 8;
/** A side with no neighbor gives way only this much, so the drag reads as a dead end. */
const DEAD_END_RESISTANCE = 0.3;
const SETTLE_MS = 200;
/** How long a landed neighbor waits for the cover's new artwork before giving up. */
const ARTWORK_WAIT_MS = 1000;
/** The space between the cover and a neighbor peeking beside it. */
export const COVER_PEEK_GAP_PX = 16;

/** Sideways swipe for the player cover. The cover follows the finger with the
 *  neighbor Track's artwork beside it; a long swipe or a fast flick slides that
 *  neighbor into place and steps the Track, anything less springs back. A
 *  mostly-vertical drag is a page scroll and never steps. */
export function useCoverSwipe({
  enabled,
  getNeighbors,
  artworkReady,
  onNext,
  onPrevious,
}: {
  enabled: boolean;
  /** Read once per swipe, as it starts — the neighbors it lands on. */
  getNeighbors: () => SwipeNeighbors;
  /** Settles once the cover shows the landed neighbor's artwork, decoded and ready to paint. */
  artworkReady: (landing: CoverPeek) => Promise<unknown>;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const [neighbors, setNeighbors] = useState<SwipeNeighbors | null>(null);
  const drag = useRef<{
    x: DragAxis;
    startY: number;
    neighbors: SwipeNeighbors | null;
  } | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settling = useRef(false);
  // A swipe that ends over the Lyrics tab must not also click it.
  const swallowClick = useRef(false);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  function settle(
    cover: HTMLElement,
    offset: number,
    landed?: { step: () => void; peek: CoverPeek },
  ) {
    settling.current = true;
    cover.style.transition = `transform ${SETTLE_MS}ms ease-out`;
    cover.style.transform = offset ? `translateX(${offset}px)` : '';
    const reset = () => {
      settling.current = false;
      cover.style.transition = 'none';
      cover.style.transform = '';
      setNeighbors(null);
    };
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (!landed) {
        reset();
        return;
      }
      landed.step();
      // The landed neighbor keeps covering the slot until the cover's new
      // artwork can paint; snapping back sooner shows an empty frame.
      void Promise.race([
        artworkReady(landed.peek).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, ARTWORK_WAIT_MS)),
      ]).then(reset);
    }, SETTLE_MS);
  }

  function release(event: PointerEvent<HTMLElement>, cancelled: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    const cover = event.currentTarget;
    if (!current.neighbors) {
      cover.style.transform = '';
      return;
    }
    swallowClick.current = true;
    const dx = event.clientX - current.x.start;
    const dy = event.clientY - current.startY;
    const landing = dx < 0 ? current.neighbors.next : current.neighbors.previous;
    const steps =
      !cancelled &&
      Math.abs(dx) > Math.abs(dy) &&
      current.x.commits(event.clientX, SWIPE_DISTANCE_PX, event.timeStamp);
    // A side with no neighbor is a dead end: stepping there would only restart the Track.
    if (!steps || !landing) {
      settle(cover, 0);
      return;
    }
    // The step waits until the neighbor sits where the cover was, so the
    // artwork swap underneath it is invisible.
    const slot = cover.offsetWidth + COVER_PEEK_GAP_PX;
    settle(cover, dx < 0 ? -slot : slot, { step: dx < 0 ? onNext : onPrevious, peek: landing });
  }

  return {
    neighbors,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (!enabled || settling.current || event.button !== 0) return;
        swallowClick.current = false;
        event.currentTarget.style.transition = 'none';
        drag.current = {
          x: new DragAxis(event.clientX, event.timeStamp),
          startY: event.clientY,
          neighbors: null,
        };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const current = drag.current;
        if (!current) return;
        const dx = current.x.move(event.clientX, event.timeStamp);
        if (!current.neighbors) {
          if (Math.abs(dx) < TAP_SLOP_PX) return;
          current.neighbors = getNeighbors();
          setNeighbors(current.neighbors);
          // Captured only once it is a swipe, so a tap still lands on the Lyrics tab.
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        const revealed = dx < 0 ? current.neighbors.next : current.neighbors.previous;
        const offset = revealed ? dx : dx * DEAD_END_RESISTANCE;
        event.currentTarget.style.transform = `translateX(${offset}px)`;
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        release(event, false);
      },
      onPointerCancel(event: PointerEvent<HTMLElement>) {
        release(event, true);
      },
      onClickCapture(event: MouseEvent<HTMLElement>) {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
