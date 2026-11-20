import { describe, expect, it } from 'vitest';
import type { QueueItem } from '@liedmotif/shared';
import {
  QUEUE_LABEL,
  countGeneratingAhead,
  coverArtSrc,
  playbackProgressPercent,
  presentIncomingSource,
  presentMiniPlayer,
  presentMiniVibeChange,
  presentPlaybackMode,
  presentSessionActivity,
  presentQueueItem,
  presentSource,
  presentTrackGenres,
  resolveCoverImageId,
} from './player-presentation';

const UUIDS = {
  queue: '00000000-0000-4000-8000-000000000001',
  track: '00000000-0000-4000-8000-000000000002',
};

function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: UUIDS.queue,
    position: 0,
    state: 'queued',
    vibeSwitchSetAside: false,
    trackId: UUIDS.track,
    track: {
      id: UUIDS.track,
      title: 'A Track',
      generatedArtistName: 'Liedmotif',
      status: 'ready',
      durationSeconds: 180,
      coverImageId: null,
      audioUrl: '/api/audio/track',
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
    durationSeconds: 180,
    assets: { final: '/api/audio/final', stream: '/api/audio/stream' },
    blendAnalysis: null,
    ...overrides,
  };
}

describe('player presentation', () => {
  it('presents the shared playback-mode cycle for full and mini players', () => {
    expect(presentPlaybackMode('loop-session')).toEqual({
      label: 'Loop Session',
      nextLabel: 'Loop Track',
      icon: 'repeat',
      highlighted: false,
    });
    expect(presentPlaybackMode('loop-track')).toEqual({
      label: 'Loop Track',
      nextLabel: 'Shuffle Session',
      icon: 'repeat-one',
      highlighted: true,
    });
    expect(presentPlaybackMode('shuffle')).toEqual({
      label: 'Shuffle Session',
      nextLabel: 'Loop Session',
      icon: 'shuffle',
      highlighted: true,
    });
  });

  it('names the playing order for the source it belongs to', () => {
    expect(QUEUE_LABEL.Session).toBe('Tracks in This Session');
    expect(QUEUE_LABEL.Playlist).toBe('Tracks in This Playlist');
  });

  it('names only the committed source without implying a provider URL', () => {
    expect(presentSource('stream')).toEqual({
      label: 'Live Stream',
      detail: 'Local final on the way',
    });
    expect(presentSource('final')).toEqual({ label: 'Local Final', detail: 'Stored locally' });
    expect(presentSource(null)).toBeNull();
  });

  it('formats the track genre line like the session cards, capped at three tags', () => {
    expect(presentTrackGenres(['lofi', 'deep-house'])).toBe('Lo-fi · Deep House');
    expect(presentTrackGenres(['jazz', 'soul', 'funk', 'blues'])).toBe('Jazz · Soul · Funk');
    expect(presentTrackGenres([])).toBeNull();
  });

  it('distinguishes current, ready, waiting, generating, and failed Queue slots', () => {
    expect(presentQueueItem(queueItem(), UUIDS.queue).kind).toBe('current');
    expect(presentQueueItem(queueItem(), null)).toMatchObject({ kind: 'ready', asset: 'final' });
    expect(
      presentQueueItem(queueItem({ assets: { final: null, stream: '/api/audio/stream' } }), null),
    ).toMatchObject({ kind: 'ready', asset: 'stream' });
    expect(
      presentQueueItem(
        queueItem({
          state: 'queued',
          track: null,
          trackId: null,
          assets: { final: null, stream: null },
        }),
        null,
      ),
    ).toMatchObject({ kind: 'waiting' });
    expect(
      presentQueueItem(
        queueItem({
          state: 'generating',
          track: null,
          trackId: null,
          assets: { final: null, stream: null },
        }),
        null,
      ),
    ).toMatchObject({ kind: 'generating' });
    expect(presentQueueItem(queueItem({ state: 'failed' }), null)).toMatchObject({
      kind: 'failed',
    });
  });

  it('counts the Tracks on the way: in-flight jobs plus unplayable slots ahead of the audible one', () => {
    const items = [
      // Behind the audible slot: not on the way, whatever its state.
      queueItem({
        id: '00000000-0000-4000-8000-000000000041',
        position: 0,
        state: 'generating',
        track: null,
        trackId: null,
        assets: { final: null, stream: null },
      }),
      queueItem({ id: '00000000-0000-4000-8000-000000000042', position: 1, state: 'playing' }),
      queueItem({ id: '00000000-0000-4000-8000-000000000043', position: 2 }),
      queueItem({
        id: '00000000-0000-4000-8000-000000000044',
        position: 3,
        state: 'generating',
        track: null,
        trackId: null,
        assets: { final: null, stream: null },
      }),
      // Arrived as a slot but holds no playable asset yet.
      queueItem({
        id: '00000000-0000-4000-8000-000000000045',
        position: 4,
        track: null,
        trackId: null,
        assets: { final: null, stream: null },
      }),
      queueItem({
        id: '00000000-0000-4000-8000-000000000046',
        position: 5,
        state: 'failed',
        assets: { final: null, stream: null },
      }),
    ];

    expect(
      countGeneratingAhead({
        items,
        currentQueueItemId: '00000000-0000-4000-8000-000000000042',
        generatingTracksAhead: 2,
      }),
    ).toBe(4);
  });

  it('never counts a disliked, skipped, or played slot ahead as on the way', () => {
    const consumedWithoutAudio = {
      track: null,
      trackId: null,
      assets: { final: null, stream: null },
    } as const;
    const items = [
      queueItem({ id: '00000000-0000-4000-8000-000000000051', position: 0, state: 'playing' }),
      // Disliked from the Queue: hidden, its reroll is the one in-flight job.
      queueItem({
        id: '00000000-0000-4000-8000-000000000052',
        position: 1,
        state: 'rejected',
        ...consumedWithoutAudio,
      }),
      queueItem({
        id: '00000000-0000-4000-8000-000000000053',
        position: 2,
        state: 'skipped',
        ...consumedWithoutAudio,
      }),
      queueItem({
        id: '00000000-0000-4000-8000-000000000054',
        position: 3,
        state: 'played',
        ...consumedWithoutAudio,
      }),
    ];

    expect(
      countGeneratingAhead({
        items,
        currentQueueItemId: '00000000-0000-4000-8000-000000000051',
        generatingTracksAhead: 1,
      }),
    ).toBe(1);
  });

  it('lets the audible Queue item override a stale playing flag', () => {
    const stale = queueItem({ id: '00000000-0000-4000-8000-000000000021', state: 'playing' });
    const audible = queueItem({ id: '00000000-0000-4000-8000-000000000022', state: 'queued' });

    expect(presentQueueItem(stale, audible.id).kind).not.toBe('current');
    expect(presentQueueItem(audible, audible.id).kind).toBe('current');
  });

  it('labels the current Queue row with its committed source, not a newer available asset', () => {
    expect(presentQueueItem(queueItem(), UUIDS.queue, 'stream')).toMatchObject({
      kind: 'current',
      asset: 'stream',
    });
  });

  it('labels the mini player with the audible track over its source name', () => {
    expect(
      presentMiniPlayer({
        sourceTitle: 'Focus Flow',
        sourceNoun: 'Session',
        track: { title: 'Night Circuit' },
        pendingTrackTitle: null,
        sectionLooping: false,
      }),
    ).toEqual({ title: 'Night Circuit', subtitle: 'Focus Flow' });
    expect(
      presentMiniPlayer({
        sourceTitle: 'Road Trip',
        sourceNoun: 'Playlist',
        track: { title: 'Night Circuit' },
        pendingTrackTitle: null,
        sectionLooping: false,
      }),
    ).toEqual({ title: 'Night Circuit', subtitle: 'Road Trip' });
  });

  it('names the source, never the player status, while no track is audible yet', () => {
    expect(
      presentMiniPlayer({
        sourceTitle: 'Focus Flow',
        sourceNoun: 'Session',
        track: null,
        pendingTrackTitle: 'First Light',
        sectionLooping: false,
      }),
    ).toEqual({ title: 'First Light', subtitle: 'Focus Flow' });
  });

  it('says what the source is when its name is already the title', () => {
    expect(
      presentMiniPlayer({
        sourceTitle: 'Focus Flow',
        sourceNoun: 'Session',
        track: null,
        pendingTrackTitle: null,
        sectionLooping: false,
      }),
    ).toEqual({ title: 'Focus Flow', subtitle: 'Session' });
    expect(
      presentMiniPlayer({
        sourceTitle: 'Focus Flow',
        sourceNoun: 'Session',
        track: { title: null },
        pendingTrackTitle: null,
        sectionLooping: false,
      }),
    ).toEqual({ title: 'Focus Flow', subtitle: 'Session' });
    expect(
      presentMiniPlayer({
        sourceTitle: null,
        sourceNoun: 'Playlist',
        track: null,
        pendingTrackTitle: null,
        sectionLooping: false,
      }),
    ).toEqual({ title: 'Untitled Playlist', subtitle: 'Playlist' });
  });

  it('surfaces an in-flight or failed Change Vibe on the mini player subtitle', () => {
    const idle = { pendingSessionId: null, error: null };
    expect(presentMiniVibeChange(idle, 's1')).toBeNull();
    expect(presentMiniVibeChange({ ...idle, pendingSessionId: 's1' }, 's1')).toEqual({
      text: 'Changing vibe…',
      tone: 'progress',
    });
    expect(presentMiniVibeChange({ ...idle, pendingSessionId: 's1' }, 's2')).toBeNull();
    expect(
      presentMiniVibeChange({ ...idle, error: { sessionId: 's1', message: 'boom' } }, 's1'),
    ).toEqual({ text: 'Change Vibe failed — open to retry', tone: 'error' });
    expect(
      presentMiniVibeChange({ ...idle, error: { sessionId: 's1', message: 'boom' } }, null),
    ).toBeNull();
  });

  it('derives a bounded progress percentage from the truthful playback sample', () => {
    expect(
      playbackProgressPercent({ positionSeconds: 45, durationSeconds: 180, playbackRate: 1 }, null),
    ).toBe(25);
    expect(
      playbackProgressPercent(
        { positionSeconds: 200, durationSeconds: 180, playbackRate: 1 },
        null,
      ),
    ).toBe(100);
    expect(
      playbackProgressPercent(
        { positionSeconds: null, durationSeconds: 180, playbackRate: 1 },
        null,
      ),
    ).toBe(0);
  });

  it('falls back to the queue-known duration when the sample clock has none (streaming)', () => {
    expect(
      playbackProgressPercent({ positionSeconds: 60, durationSeconds: null, playbackRate: 1 }, 240),
    ).toBe(25);
    // The live sample outranks queue metadata once it knows its own length.
    expect(
      playbackProgressPercent({ positionSeconds: 45, durationSeconds: 180, playbackRate: 1 }, 240),
    ).toBe(25);
  });

  it('estimates streaming progress against an assumed length, never claiming completion', () => {
    // No length anywhere: assume 180 s so the bar still moves…
    expect(
      playbackProgressPercent(
        { positionSeconds: 45, durationSeconds: null, playbackRate: 1 },
        null,
      ),
    ).toBe(25);
    // …but cap the estimate — a long track must not read as finished.
    expect(
      playbackProgressPercent(
        { positionSeconds: 300, durationSeconds: null, playbackRate: 1 },
        null,
      ),
    ).toBe(95);
    expect(
      playbackProgressPercent({ positionSeconds: 0, durationSeconds: null, playbackRate: 1 }, null),
    ).toBe(0);
  });

  it('resolves artwork as live Session Cover, then summary cover, then the track own art', () => {
    const player = (sessionCoverImageId: string | null, trackCoverImageId: string | null) => ({
      sessionCoverImageId,
      currentTrack: { coverImageId: trackCoverImageId },
    });
    expect(resolveCoverImageId(player('live', 'track'), { coverImageId: 'summary' })).toBe('live');
    expect(resolveCoverImageId(player(null, 'track'), { coverImageId: 'summary' })).toBe('summary');
    expect(resolveCoverImageId(player(null, 'track'), { coverImageId: null })).toBe('track');
    expect(
      resolveCoverImageId(
        { sessionCoverImageId: null, currentTrack: null },
        { coverImageId: null },
      ),
    ).toBe(null);
  });

  it('narrates the incoming Session on the cover chip while the audible one keeps playing', () => {
    expect(
      presentIncomingSource(
        { stage: 'preparing', noun: 'Session', title: 'Night Drive' },
        'Session',
      ),
    ).toEqual({
      chip: 'Preparing “Night Drive”…',
      detail: 'This session keeps playing until the new one is ready.',
    });
    expect(
      presentIncomingSource({ stage: 'preparing', noun: 'Session', title: null }, 'Session'),
    ).toEqual({
      chip: 'Preparing your next session…',
      detail: 'This session keeps playing until the new one is ready.',
    });
    expect(presentIncomingSource({ stage: 'connecting' }, 'Session')).toEqual({
      chip: 'Setting the vibe…',
      detail: 'This session keeps playing until the new one is ready.',
    });
  });

  it('names an incoming Playlist "Next Playlist"', () => {
    const playlist = { stage: 'preparing', noun: 'Playlist', title: null } as const;
    expect(presentIncomingSource(playlist, 'Session').chip).toBe('Preparing your next playlist…');
    expect(presentIncomingSource({ ...playlist, title: 'Focus Nights' }, 'Session').chip).toBe(
      'Preparing “Focus Nights”…',
    );
    expect(
      presentSessionActivity({
        incoming: playlist,
        vibeChangeCaption: null,
        sessionRepeat: false,
        generatingAhead: 0,
      }),
    ).toEqual({ label: 'Next Playlist', tone: 'active' });
  });

  it('says the Playlist keeps playing while a Session is prepared behind it', () => {
    expect(
      presentIncomingSource({ stage: 'preparing', noun: 'Session', title: null }, 'Playlist'),
    ).toEqual({
      chip: 'Preparing your next session…',
      detail: 'This playlist keeps playing until the new one is ready.',
    });
    expect(presentIncomingSource({ stage: 'connecting' }, 'Playlist').detail).toBe(
      'This playlist keeps playing until the new one is ready.',
    );
  });

  it('names the Tracks on the way as active Session work', () => {
    expect(
      presentSessionActivity({
        incoming: null,
        vibeChangeCaption: null,
        sessionRepeat: false,
        generatingAhead: 2,
      }),
    ).toEqual({ label: 'Generating 2', tone: 'active' });
  });

  it('shows no Session status when nothing is happening', () => {
    expect(
      presentSessionActivity({
        incoming: null,
        vibeChangeCaption: null,
        sessionRepeat: false,
        generatingAhead: 0,
      }),
    ).toBeNull();
  });

  it('explains a Repeat Session calmly, but only while nothing generates', () => {
    const repeat = { incoming: null, vibeChangeCaption: null, sessionRepeat: true };
    expect(presentSessionActivity({ ...repeat, generatingAhead: 0 })).toEqual({
      label: 'Repeat',
      tone: 'muted',
    });
    // A Repeat Session still filling its first batch, or one that hit a limit
    // with jobs already submitted, is spending: it must not claim the zero-cost
    // state.
    expect(presentSessionActivity({ ...repeat, generatingAhead: 1 })).toEqual({
      label: 'Generating 1',
      tone: 'active',
    });
  });

  it('ranks the Session status: next Session, then Change Vibe, then generating', () => {
    const busy = {
      sessionRepeat: true,
      generatingAhead: 2,
      vibeChangeCaption: 'New vibe queued',
    };
    expect(
      presentSessionActivity({
        ...busy,
        incoming: { stage: 'preparing', noun: 'Session', title: null },
      }),
    ).toEqual({
      label: 'Next Session',
      tone: 'active',
    });
    expect(presentSessionActivity({ ...busy, incoming: null })).toEqual({
      label: 'New vibe queued',
      tone: 'active',
    });
  });

  it('falls back to the built-in placeholder art when no cover id is known', () => {
    expect(coverArtSrc('00000000-0000-4000-8000-000000000031')).toBe(
      '/api/covers/00000000-0000-4000-8000-000000000031',
    );
    expect(coverArtSrc(null)).toBe('/api/covers/placeholder');
  });

  it('asks for the downscaled rendition when a tile wants the thumb', () => {
    expect(coverArtSrc('00000000-0000-4000-8000-000000000031', 'thumb')).toBe(
      '/api/covers/00000000-0000-4000-8000-000000000031?w=160',
    );
    expect(coverArtSrc(null, 'thumb')).toBe('/api/covers/placeholder?w=160');
  });
});

describe('presentMiniPlayer during a Section loop', () => {
  it('says the Track is looping, in place of where it comes from', () => {
    expect(
      presentMiniPlayer({
        sourceTitle: 'Late Night',
        sourceNoun: 'Session',
        track: { title: 'Root Systems' },
        pendingTrackTitle: null,
        sectionLooping: true,
      }),
    ).toEqual({ title: 'Root Systems', subtitle: 'Looping a part' });
  });
});
