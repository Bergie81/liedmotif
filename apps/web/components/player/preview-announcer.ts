'use client';

// The bridge that lets the mini player MIRROR a track preview without the
// preview ever entering the transport: a lone Track is never a Playback
// source (only Session and Playlist are), so the page-local preview
// <audio> merely announces itself here and the mini player reflects it. The
// announcement dies with its page (previews stop on navigation), after which
// the mini player falls back to the engaged source.

import { useSyncExternalStore } from 'react';

export interface TrackPreviewAnnouncement {
  trackId: string;
  title: string | null;
  artist: string | null;
  coverImageId: string | null;
  playing: boolean;
  /** Pause/resume the preview in place — the mini player's one control. */
  toggle: () => void;
}

/** Identifies the announcing surface, so one page's cleanup can never clear a
 *  newer page's announcement. */
export type PreviewOwner = symbol;

export function createPreviewOwner(): PreviewOwner {
  return Symbol('track-preview-owner');
}

let current: { owner: PreviewOwner; announcement: TrackPreviewAnnouncement } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function announceTrackPreview(
  owner: PreviewOwner,
  announcement: TrackPreviewAnnouncement,
): void {
  current = { owner, announcement };
  emit();
}

export function clearTrackPreview(owner: PreviewOwner): void {
  if (current?.owner !== owner) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): TrackPreviewAnnouncement | null {
  return current?.announcement ?? null;
}

/** The live announcement, or null when no preview is up (SSR always null). */
export function useTrackPreviewAnnouncement(): TrackPreviewAnnouncement | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
