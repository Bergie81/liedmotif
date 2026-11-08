// The access seam for owned content. Ownership
// is the authorization axis for every write; reads carry exactly ONE exception:
// content the owner placed In Lounge for the viewer (the Lounge-audible
// predicate — the owner's share audience is the only grant). There is still NO
// admin override — not even as a parameter: an override branch added "for
// convenience" is exactly the branch that leaks.
//
// WHERE THE BOUNDARY ACTUALLY LIVES: for owned rows it is the repository query,
// not this module. Every byte-serving and detail route reads through a scoped
// query — strictly owner-scoped `getOwned*` (`getOwnedDownloadableTrack`,
// `getPersonReferencePhoto`, …), or owner-or-Lounge-audible `getReadable*`
// (`getReadableTrackPlaybackAudio`, …) composing the ONE SQL predicate in
// `viewerCanReadTrack` (`@liedmotif/db`) — so an unreadable row is never fetched
// at all and an unknown id is indistinguishable from an unreadable one. That is
// strictly stronger than fetching a row and deciding about it afterwards, and
// it is the pattern to keep: this module is NOT a licence to widen those
// queries and filter in application code.
//
// What is left over is the one case a where-clause cannot express — a row that
// may be instance-global OR owned — which is why covers are the only predicate
// here. A second predicate belongs here when a new subject has that same shape,
// not for a subject an owner-scoped query already covers. Framework-free on
// purpose, so web routes and the worker share it.

/** Strictly "the viewer is the owner" — the whole authorization model today. */
function viewerIsOwner(viewerUserId: string, ownerUserId: string): boolean {
  return viewerUserId === ownerUserId;
}

/**
 * Covers carry their owner in provenance, and exactly one kind has no owner to
 * carry: the built-in placeholder, which is instance-global branded art and is
 * readable by every signed-in user. Every other cover may contain its owner's
 * personal reference imagery and is served to that owner alone — a missing
 * owner is unattributed, not public, so it is refused rather than shared out.
 * Because one query must return both kinds, this is decided about the FETCHED
 * row rather than in the where-clause.
 *
 * `loungeVisible` is the Lounge widening: true means the viewer's Lounge
 * currently exposes this cover (it fronts a Track Lounge-audible to them or a
 * Playlist in the Lounge for them — resolved in SQL by `isCoverLoungeVisible`,
 * the db half of this predicate pair). The grant is anchored on the OWNER's
 * share, not on who the provenance names, so it wins even over a missing
 * provenance owner. Callers may omit it and re-ask with the resolved value
 * only when ownership refuses, keeping the common own-cover path free of the
 * extra query.
 */
export function canReadCover(
  viewerUserId: string,
  cover: { sourceType: string; provenanceOwnerUserId: string | null; loungeVisible?: boolean },
): boolean {
  if (cover.sourceType === 'placeholder') return true;
  if (cover.loungeVisible === true) return true;
  if (cover.provenanceOwnerUserId === null) return false;
  return viewerIsOwner(viewerUserId, cover.provenanceOwnerUserId);
}
