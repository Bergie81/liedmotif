// @vitest-environment jsdom

// The loop head is still in the Session's Queue even though the read window
// left it out: right after the Repeat wrap it is the audible Track, and a poll
// anchored at the old tail must not report it as gone (a Loop Track pin or a
// Section loop on it would end and release its hold).
// (`createElement` because web tests are `.test.ts` — see the root Vitest include.)

import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFetches } from '@/tests/helpers/capture-fetches';
import { useSessionQueue, type SessionQueueSnapshot } from './use-session-queue';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const HEAD_ID = '00000000-0000-4000-8000-0000000000a1';
const HEAD_TRACK_ID = '00000000-0000-4000-8000-0000000000b1';
const TAIL_ID = '00000000-0000-4000-8000-0000000000a2';
const TAIL_TRACK_ID = '00000000-0000-4000-8000-0000000000b2';

function queueItem(id: string, trackId: string, position: number) {
  return {
    id,
    position,
    state: 'played',
    vibeSwitchSetAside: false,
    trackId,
    track: {
      id: trackId,
      title: 'Track',
      generatedArtistName: null,
      status: 'ready',
      durationSeconds: 30,
      coverImageId: null,
      audioUrl: null,
      savedAt: null,
      favoritedAt: null,
      inCuratedPlaylist: false,
      dislikedAt: null,
      genreTags: [],
      vocalMode: 'instrumental',
      hasLyrics: false,
      downloadable: true,
    },
    targetBpm: null,
    targetKey: null,
    styleRevision: 1,
    durationSeconds: 30,
    assets: { final: `/api/audio/${trackId}?asset=final`, stream: null },
    blendAnalysis: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the loop head in a windowed queue read', () => {
  it('counts as a Queue item of the Session, outside the window', async () => {
    const requests = captureFetches();
    const snapshots: SessionQueueSnapshot[] = [];
    function Probe() {
      useSessionQueue(
        SESSION_ID,
        () => false,
        (snapshot) => snapshots.push(snapshot),
        () => true,
      );
      return null;
    }
    render(createElement(Probe));
    await act(async () => {
      requests[0]!.respond({
        ok: true,
        data: {
          sessionId: SESSION_ID,
          sessionStatus: 'active',
          generationStatus: 'ok',
          generationStatusScope: null,
          statusMessageSafe: null,
          coverImageId: null,
          styleRevision: 1,
          currentTrackId: TAIL_TRACK_ID,
          currentQueueItemId: TAIL_ID,
          earlierTracks: 59,
          items: [queueItem(TAIL_ID, TAIL_TRACK_ID, 59)],
          loopHead: queueItem(HEAD_ID, HEAD_TRACK_ID, 0),
          generatingTracksAhead: 0,
          generatingNewVibeTracksAhead: 0,
          pendingGeneration: null,
          vibe: null,
          switchPending: false,
          tryAgainTracks: 2,
        },
      });
    });

    const snapshot = snapshots.at(-1)!;
    expect(snapshot.loopHead?.queueItemId).toBe(HEAD_ID);
    expect(snapshot.tracks.map((track) => track.queueItemId)).toEqual([TAIL_ID]);
    expect(snapshot.queueItemIds.has(HEAD_ID)).toBe(true);
  });
});
