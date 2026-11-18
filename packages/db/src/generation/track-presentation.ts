// Shared resolution rules for how a Track presents to the outside world (ID3
// embed, Track Data): one source of truth so the file tags and the details
// surface can never disagree.

import { truncateTrackDataPrompt } from '@liedmotif/shared';
import type { LicenseMetadata } from '../schema/types';

/** The artist on a user's music: the profile's Artist Name when set, else the
 *  User name — never a provider, model, or app name (the files are the user's
 *  music). */
export function resolveArtistName(artistName: string | null, userName: string): string {
  return artistName?.trim() || userName;
}

/**
 * The prompt history that produced a Track: the request's stamp, frozen at
 * generation time. An empty stamp is a frozen "no prompt" (the Session had no
 * history yet, as after More Like This) and shows nothing. Only legacy
 * requests, which carry no stamp at all (null), fall back to the owning
 * Session's live value — so a Track that outlived its Session, or whose
 * Session has since been re-styled, still answers with its own story.
 */
export function resolveTrackDataPrompt(
  stampedPrompt: string | null,
  sessionPrompt: string | null,
): string | null {
  if (stampedPrompt === '') return null;
  return truncateTrackDataPrompt(stampedPrompt ?? sessionPrompt);
}

/** The rights note: the track's own column, else the license-provenance blob's. */
export function resolveLicenseNote(
  rightsNote: string | null,
  licenseMetadata: LicenseMetadata | null,
): string | null {
  return rightsNote ?? licenseMetadata?.rightsNote ?? null;
}
