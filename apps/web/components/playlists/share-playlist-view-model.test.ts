import type { ShareCandidate } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import {
  initialShareSelection,
  isShareTicked,
  shareCommit,
  toggleShareSelection,
} from './share-playlist-view-model';

// The share picker's audience rules: only "All" means the
// `everyone` audience — Users who join later included. Individual ticks are
// always an exact list, even one that names every current User, and ticking
// nobody on a shared playlist is Return to Private.

const candidate = (userId: string): ShareCandidate => ({
  userId,
  name: userId,
  artistName: null,
  imageUrl: null,
});
const CANDIDATES = [candidate('u-anna'), candidate('u-jonas'), candidate('u-admin')];
const ALL_IDS = ['u-anna', 'u-jonas', 'u-admin'];

const ids = (selection: ReturnType<typeof initialShareSelection>) =>
  selection === 'everyone' ? selection : [...selection];

describe('initialShareSelection', () => {
  it('opens an everyone audience on All', () => {
    expect(initialShareSelection({ kind: 'everyone' }, CANDIDATES)).toBe('everyone');
  });

  it('opens a selected audience as its list, even when it names every current User', () => {
    expect(ids(initialShareSelection({ kind: 'selected', userIds: ALL_IDS }, CANDIDATES))).toEqual(
      ALL_IDS,
    );
  });

  it('ticks only the listed Users that are still candidates', () => {
    const selection = initialShareSelection(
      { kind: 'selected', userIds: ['u-jonas', 'u-gone'] },
      CANDIDATES,
    );
    expect(ids(selection)).toEqual(['u-jonas']);
  });

  it('ticks nobody for a Private playlist', () => {
    expect(ids(initialShareSelection(null, CANDIDATES))).toEqual([]);
  });
});

describe('toggleShareSelection', () => {
  it('adds and removes one User without mutating the current selection', () => {
    const current = new Set(['u-anna']);
    const added = toggleShareSelection(current, 'u-jonas', CANDIDATES);
    expect(ids(added)).toEqual(['u-anna', 'u-jonas']);
    expect(ids(toggleShareSelection(added, 'u-anna', CANDIDATES))).toEqual(['u-jonas']);
    expect([...current]).toEqual(['u-anna']);
  });

  it('unticking one User from All leaves an exact list of everyone else', () => {
    expect(ids(toggleShareSelection('everyone', 'u-jonas', CANDIDATES))).toEqual([
      'u-anna',
      'u-admin',
    ]);
  });

  it('ticking every User one by one stays an exact list, never All', () => {
    let selection = initialShareSelection(null, CANDIDATES);
    for (const id of ALL_IDS) selection = toggleShareSelection(selection, id, CANDIDATES);
    expect(selection).not.toBe('everyone');
    expect(ids(selection)).toEqual(ALL_IDS);
  });
});

describe('isShareTicked', () => {
  it('ticks every User under All and only the listed ones otherwise', () => {
    expect(isShareTicked('everyone', 'u-admin')).toBe(true);
    expect(isShareTicked(new Set(['u-anna']), 'u-anna')).toBe(true);
    expect(isShareTicked(new Set(['u-anna']), 'u-jonas')).toBe(false);
  });
});

describe('shareCommit', () => {
  it('shares a Private playlist with everyone from All', () => {
    expect(shareCommit({ selection: 'everyone', candidates: CANDIDATES, current: null })).toEqual({
      audience: { kind: 'everyone' },
      label: 'Share',
      disabled: false,
    });
  });

  it('shares with exactly the ticked Users, in list order', () => {
    expect(
      shareCommit({
        selection: new Set(['u-admin', 'u-anna']),
        candidates: CANDIDATES,
        current: null,
      }),
    ).toEqual({
      audience: { kind: 'selected', userIds: ['u-anna', 'u-admin'] },
      label: 'Share',
      disabled: false,
    });
  });

  it('shares with a list naming every current User when each was ticked by hand', () => {
    expect(
      shareCommit({ selection: new Set(ALL_IDS), candidates: CANDIDATES, current: null }).audience,
    ).toEqual({ kind: 'selected', userIds: ALL_IDS });
  });

  it('cannot share a Private playlist with nobody', () => {
    expect(shareCommit({ selection: new Set(), candidates: CANDIDATES, current: null })).toEqual({
      audience: null,
      label: 'Share',
      disabled: true,
    });
  });

  it('returns a shared playlist to Private when nobody is ticked', () => {
    expect(
      shareCommit({ selection: new Set(), candidates: CANDIDATES, current: { kind: 'everyone' } }),
    ).toEqual({ audience: null, label: 'Return to Private', disabled: false });
  });

  it('saves a changed audience on a shared playlist', () => {
    expect(
      shareCommit({
        selection: new Set(['u-anna']),
        candidates: CANDIDATES,
        current: { kind: 'everyone' },
      }),
    ).toEqual({
      audience: { kind: 'selected', userIds: ['u-anna'] },
      label: 'Save',
      disabled: false,
    });
  });

  it('saves widening a list that names every current User to All', () => {
    expect(
      shareCommit({
        selection: 'everyone',
        candidates: CANDIDATES,
        current: { kind: 'selected', userIds: ALL_IDS },
      }),
    ).toEqual({ audience: { kind: 'everyone' }, label: 'Save', disabled: false });
  });

  it('has nothing to save while the audience is unchanged', () => {
    expect(
      shareCommit({ selection: 'everyone', candidates: CANDIDATES, current: { kind: 'everyone' } })
        .disabled,
    ).toBe(true);
    expect(
      shareCommit({
        selection: new Set(['u-jonas', 'u-anna']),
        candidates: CANDIDATES,
        current: { kind: 'selected', userIds: ['u-anna', 'u-jonas'] },
      }).disabled,
    ).toBe(true);
    expect(
      shareCommit({
        selection: initialShareSelection({ kind: 'selected', userIds: ALL_IDS }, CANDIDATES),
        candidates: CANDIDATES,
        current: { kind: 'selected', userIds: ALL_IDS },
      }).disabled,
    ).toBe(true);
  });

  it('saves a selected audience that names a User who is no longer a candidate', () => {
    const commit = shareCommit({
      selection: new Set(['u-jonas']),
      candidates: CANDIDATES,
      current: { kind: 'selected', userIds: ['u-jonas', 'u-gone'] },
    });
    expect(commit).toEqual({
      audience: { kind: 'selected', userIds: ['u-jonas'] },
      label: 'Save',
      disabled: false,
    });
  });

  describe('on a solo Instance (no candidates)', () => {
    it('shares a Private playlist with everyone, Users invited later included', () => {
      expect(shareCommit({ selection: new Set(), candidates: [], current: null })).toEqual({
        audience: { kind: 'everyone' },
        label: 'Share',
        disabled: false,
      });
    });

    it('offers Return to Private for a shared playlist — the only change left to make', () => {
      expect(
        shareCommit({ selection: 'everyone', candidates: [], current: { kind: 'everyone' } }),
      ).toEqual({ audience: null, label: 'Return to Private', disabled: false });
    });
  });
});
