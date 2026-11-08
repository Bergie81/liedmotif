'use client';

/** Read the player clock now and every `intervalMs` ms, skipping ticks while
 * the tab is hidden: a hidden tab paints nothing, so sampling it only burns
 * wake-ups and re-renders, and the first visible tick re-syncs the surface.
 * Returns the effect cleanup. */
export function pollWhileVisible(intervalMs: number, read: () => void): () => void {
  const tick = () => {
    if (document.visibilityState === 'hidden') return;
    read();
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}
