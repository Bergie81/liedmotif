import { describe, expect, it } from 'vitest';
import type { QueueItem } from '@liedmotif/shared';
import {
  presentVibeChangeCaption,
  presentVibeChangePending,
  presentVibeSwitch,
  resolveVibeCutoverIndex,
  resolveVibeCutoverOnEdge,
  vibeBoundarySignals,
} from './vibe-switch-view';

interface Entry {
  queueItemId: string;
  styleRevision: number | null;
  queueState: QueueItem['state'];
}

function entry(
  id: string,
  styleRevision: number | null,
  queueState: Entry['queueState'] = 'queued',
): Entry {
  return { queueItemId: id, styleRevision, queueState };
}

function statusItems(...entries: Entry[]) {
  return entries.map((item, position) => ({
    id: item.queueItemId,
    position,
    state: item.queueState,
    styleRevision: item.styleRevision,
  }));
}

describe('resolveVibeCutoverIndex (early advance after the server cutover)', () => {
  const queue = [entry('a', 1, 'playing'), entry('b', 1, 'skipped'), entry('c', 2)];

  it('targets the first new-revision track while an old-revision track is audible', () => {
    expect(resolveVibeCutoverIndex(queue, 2, entry('a', 1, 'playing'))).toBe(2);
  });

  it('does nothing when the audible track already carries the new revision', () => {
    expect(resolveVibeCutoverIndex(queue, 2, entry('c', 2))).toBeNull();
  });

  it('does nothing with no audible track (the cursor logic handles idle states)', () => {
    expect(resolveVibeCutoverIndex(queue, 2, null)).toBeNull();
  });

  it('does nothing when no new-revision track is in the playable projection yet', () => {
    expect(
      resolveVibeCutoverIndex([entry('a', 1, 'playing'), entry('b', 1)], 2, entry('a', 1)),
    ).toBeNull();
  });

  it('never targets a set-aside item even at the new revision', () => {
    expect(
      resolveVibeCutoverIndex(
        [entry('a', 1, 'playing'), entry('c', 2, 'skipped'), entry('d', 2)],
        2,
        entry('a', 1),
      ),
    ).toBe(2);
  });
});

describe('resolveVibeCutoverOnEdge (one-shot falling-edge gate)', () => {
  const queue = [entry('a', 1, 'playing'), entry('c', 2)];
  const base = { tracks: queue, sessionStyleRevision: 2, active: entry('a', 1, 'playing') };

  it('fires only on the armed → cleared transition', () => {
    expect(
      resolveVibeCutoverOnEdge({ ...base, wasSwitchPending: true, switchPending: false }),
    ).toBe(1);
    expect(
      resolveVibeCutoverOnEdge({ ...base, wasSwitchPending: false, switchPending: false }),
    ).toBeNull();
    expect(
      resolveVibeCutoverOnEdge({ ...base, wasSwitchPending: true, switchPending: true }),
    ).toBeNull();
    expect(
      resolveVibeCutoverOnEdge({ ...base, wasSwitchPending: false, switchPending: true }),
    ).toBeNull();
  });
});

describe('vibeBoundarySignals (queue divider + queued note)', () => {
  it('marks the boundary before the first current-revision item when older ones precede', () => {
    const items = [
      { id: 'a', styleRevision: 1 },
      { id: 'b', styleRevision: 1 },
      { id: 'c', styleRevision: 2 },
    ];
    expect(vibeBoundarySignals(items, 2)).toEqual({
      boundaryBeforeItemId: 'c',
      changeQueued: false,
    });
  });

  it('reports a queued change while no current-revision item exists yet', () => {
    const items = [{ id: 'a', styleRevision: 1 }];
    expect(vibeBoundarySignals(items, 2)).toEqual({
      boundaryBeforeItemId: null,
      changeQueued: true,
    });
  });

  it('is silent for a uniform queue (no vibe change in flight)', () => {
    const items = [
      { id: 'a', styleRevision: 2 },
      { id: 'b', styleRevision: 2 },
    ];
    expect(vibeBoundarySignals(items, 2)).toEqual({
      boundaryBeforeItemId: null,
      changeQueued: false,
    });
    expect(vibeBoundarySignals([], 1)).toEqual({ boundaryBeforeItemId: null, changeQueued: false });
  });

  it('treats a null/legacy item revision as pre-change', () => {
    const items = [
      { id: 'a', styleRevision: null },
      { id: 'b', styleRevision: 2 },
    ];
    expect(vibeBoundarySignals(items, 2)).toEqual({
      boundaryBeforeItemId: 'b',
      changeQueued: false,
    });
  });

  it('stays silent when the boundary fell out of the windowed read', () => {
    // The server's windowed queue read can elide every old-revision slot; the
    // visible window is then uniform at the new revision and must read as
    // "nothing in flight" — a long-consumed vibe change never resurrects a
    // divider or a queued note.
    const windowed = [
      { id: 'w1', styleRevision: 2 },
      { id: 'w2', styleRevision: 2 },
    ];
    expect(vibeBoundarySignals(windowed, 2)).toEqual({
      boundaryBeforeItemId: null,
      changeQueued: false,
    });
  });
});

describe('presentVibeChangeCaption', () => {
  const current = entry('current', 1, 'playing');
  const oldA = entry('old-a', 1);

  it('narrates arrived new-vibe Tracks', () => {
    expect(
      presentVibeChangeCaption({
        items: statusItems(current, oldA, entry('new', 2, 'queued')),
        currentTrackStyleRevision: 1,
        sessionStyleRevision: 2,
        generatingNewVibeTracksAhead: 0,
      }),
    ).toBe('New vibe queued');
  });

  it('does not read a consumed new-vibe Track as one still ahead', () => {
    // Its Track played (or lost its audio) and the loop came back round to the
    // old vibe: nothing new is ahead, so the status must promise nothing.
    expect(
      presentVibeChangeCaption({
        items: statusItems(entry('new', 2, 'played'), current),
        currentTrackStyleRevision: 1,
        sessionStyleRevision: 2,
        generatingNewVibeTracksAhead: 0,
      }),
    ).toBeNull();
  });

  it('keeps the queued narration while the new vibe is generating with nothing arrived', () => {
    expect(
      presentVibeChangeCaption({
        items: statusItems(current),
        currentTrackStyleRevision: 1,
        sessionStyleRevision: 2,
        generatingNewVibeTracksAhead: 2,
      }),
    ).toBe('Queuing new vibe…');
  });

  it('promises nothing when the revision moved but no new-vibe Track is on the way', () => {
    // The fill can be refused (cost limit, provider block) after the revision
    // bumped: the status must not keep claiming tracks are coming.
    expect(
      presentVibeChangeCaption({
        items: statusItems(current),
        currentTrackStyleRevision: 1,
        sessionStyleRevision: 2,
        generatingNewVibeTracksAhead: 0,
      }),
    ).toBeNull();
  });

  it('is silent while no Track is loaded in a Session that never changed vibe', () => {
    // A cold start (or a reload before Play) has no current Track; its own
    // first slots are not a new vibe.
    expect(
      presentVibeChangeCaption({
        items: statusItems(entry('first', 1, 'generating'), entry('second', 1, 'queued')),
        currentTrackStyleRevision: null,
        sessionStyleRevision: 1,
        generatingNewVibeTracksAhead: 2,
      }),
    ).toBeNull();
  });

  it('keeps a legacy current track narrated when new-revision Queue work exists', () => {
    expect(
      presentVibeChangeCaption({
        items: statusItems(entry('legacy-current', null, 'playing'), entry('new', 2, 'planned')),
        currentTrackStyleRevision: null,
        sessionStyleRevision: 2,
        generatingNewVibeTracksAhead: 0,
      }),
    ).toBe('New vibe queued');
  });

  it('is silent for an initial Session whose Track revisions predate revision tracking', () => {
    // Its ordinary buffer top-ups all count as live-revision work, so the count
    // alone must never read as a vibe change.
    expect(
      presentVibeChangeCaption({
        items: statusItems(
          entry('played', null, 'played'),
          entry('skipped', null, 'skipped'),
          entry('labrador-lover', null, 'skipped'),
        ),
        currentTrackStyleRevision: null,
        sessionStyleRevision: 1,
        generatingNewVibeTracksAhead: 2,
      }),
    ).toBeNull();
  });

  it('is silent once the audible track carries the live vibe revision', () => {
    expect(
      presentVibeChangeCaption({
        items: statusItems(entry('current-new', 2, 'playing')),
        currentTrackStyleRevision: 2,
        sessionStyleRevision: 2,
        generatingNewVibeTracksAhead: 2,
      }),
    ).toBeNull();
  });

  it('narrates an in-flight Change Vibe request before the server has re-styled', () => {
    // The session revision still matches the audible track (the restyle has not
    // landed), which is exactly when every other branch stays silent.
    expect(
      presentVibeChangeCaption({
        items: statusItems(entry('current', 1, 'playing')),
        currentTrackStyleRevision: 1,
        sessionStyleRevision: 1,
        generatingNewVibeTracksAhead: 2,
        requestPending: true,
      }),
    ).toBe('Changing vibe…');
  });
});

describe('presentVibeChangePending', () => {
  it('offers the cover chip only while the request is in flight', () => {
    expect(presentVibeChangePending(false)).toBeNull();
    expect(presentVibeChangePending(true)).toEqual({
      chip: 'Changing vibe…',
      detail: 'The new direction is being prepared — you can keep listening and browsing.',
    });
  });
});

describe('presentVibeSwitch', () => {
  it('narrates only while switch-now is pending', () => {
    expect(presentVibeSwitch(true)).toEqual({
      chip: 'Switching to the new vibe…',
      detail: 'This vibe keeps playing until the new one is ready.',
    });
    expect(presentVibeSwitch(false)).toBeNull();
  });
});
