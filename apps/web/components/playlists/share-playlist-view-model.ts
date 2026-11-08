// The share picker's audience rules. Only "All" means the
// `everyone` audience, which reaches Users who join later too; individual
// ticks are always an exact list, even one that names every current User.

import type { ShareAudience, ShareCandidate } from '@liedmotif/shared';

/** What the picker holds: All, or exactly these ticked Users. */
export type ShareSelection = 'everyone' | ReadonlySet<string>;

/** The ticks the picker opens with: the playlist's current audience. */
export function initialShareSelection(
  audience: ShareAudience | null,
  candidates: ShareCandidate[],
): ShareSelection {
  if (!audience) return new Set();
  if (audience.kind === 'everyone') return 'everyone';
  const listed = new Set(audience.userIds);
  // A User removed since the share was made is no longer pickable.
  return new Set(candidates.filter((c) => listed.has(c.userId)).map((c) => c.userId));
}

export function isShareTicked(selection: ShareSelection, userId: string): boolean {
  return selection === 'everyone' || selection.has(userId);
}

/** Flip one User. Unticking from All leaves the exact list of everyone else. */
export function toggleShareSelection(
  selection: ShareSelection,
  userId: string,
  candidates: ShareCandidate[],
): ShareSelection {
  const next = new Set(selection === 'everyone' ? candidates.map((c) => c.userId) : selection);
  if (next.has(userId)) next.delete(userId);
  else next.add(userId);
  return next;
}

export interface ShareCommit {
  /** What the confirm button sends; null returns the playlist to Private. */
  audience: ShareAudience | null;
  label: 'Share' | 'Save' | 'Return to Private';
  disabled: boolean;
}

/**
 * The confirm button for the current selection. With no other User on the
 * Instance there is nobody to pick, so the button toggles: a Private playlist
 * shares with everyone, a shared one returns to Private.
 */
export function shareCommit({
  selection,
  candidates,
  current,
}: {
  selection: ShareSelection;
  candidates: ShareCandidate[];
  /** The playlist's audience as last loaded; null when Private. */
  current: ShareAudience | null;
}): ShareCommit {
  const audience = audienceFor(selection, candidates, current);
  if (current === null) {
    return { audience, label: 'Share', disabled: audience === null };
  }
  if (audience === null) return { audience, label: 'Return to Private', disabled: false };
  return { audience, label: 'Save', disabled: sameAudience(audience, current) };
}

function audienceFor(
  selection: ShareSelection,
  candidates: ShareCandidate[],
  current: ShareAudience | null,
): ShareAudience | null {
  if (candidates.length === 0) return current === null ? { kind: 'everyone' } : null;
  if (selection === 'everyone') return { kind: 'everyone' };
  const userIds = candidates.map((c) => c.userId).filter((id) => selection.has(id));
  return userIds.length > 0 ? { kind: 'selected', userIds } : null;
}

function sameAudience(a: ShareAudience, b: ShareAudience): boolean {
  if (a.kind === 'everyone' || b.kind === 'everyone') return a.kind === b.kind;
  const ids = new Set(a.userIds);
  return a.userIds.length === b.userIds.length && b.userIds.every((id) => ids.has(id));
}
