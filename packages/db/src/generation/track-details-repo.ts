// Track descriptive read for the Track Data surface: one query resolving the
// track's own metadata plus its request's prompts and its owning Session's
// title/user prompt. Scoped owner-or-Lounge-audible — a Visitor
// sees the full Track Data of a shared track, attributed to its owner.
// Deliberately narrow — nothing vendor-secret is selected (no encrypted URLs,
// seeds, lyric context, or raw provider payloads), so the route cannot leak
// what it never loads.

import { and, eq } from 'drizzle-orm';
import type { VocalMode } from '@liedmotif/shared';
import type { Database } from '../client';
import { user } from '../schema/auth';
import { viewerCanReadTrack } from '../playlists/lounge-audible';
import { activitySessions, generationRequests, tracks, listenerProfiles } from '../schema';
import {
  resolveArtistName,
  resolveLicenseNote,
  resolveTrackDataPrompt,
} from './track-presentation';

export interface ReadableTrackDetails {
  title: string | null;
  sessionTitle: string | null;
  /** The resolved artist (`resolveArtistName`) — same rule as the MP3 embed. */
  artistName: string;
  createdAt: Date;
  durationSeconds: number | null;
  /** The prompt history frozen when this Track was generated (`resolveTrackDataPrompt`). */
  userPrompt: string | null;
  stylePrompt: string | null;
  expandedPrompt: string | null;
  genreTags: string[];
  activity: string | null;
  mood: string | null;
  energy: string | null;
  vocalMode: VocalMode;
  /** The request Style Snapshot's detected language; null/'' when not vocal. */
  language: string | null;
  bpmEstimate: number | null;
  providerKey: string;
  providerModel: string | null;
  /** `tracks.rightsNote`, else `licenseMetadata.rightsNote`. */
  licenseNote: string | null;
}

/**
 * One readable track's descriptive data; null for a missing/unreadable track
 * (the caller's uniform 404). The session/request legs are LEFT joins — a
 * track that outlived its session still answers with its own fields. The
 * artist attribution stays anchored on the track's OWNER, never the viewer.
 */
export async function getReadableTrackDetails(
  db: Database,
  args: { viewerUserId: string; trackId: string },
): Promise<ReadableTrackDetails | null> {
  const [row] = await db
    .select({
      title: tracks.title,
      sessionTitle: activitySessions.title,
      artistName: listenerProfiles.artistName,
      userName: user.name,
      createdAt: tracks.createdAt,
      durationSeconds: tracks.durationSeconds,
      stampedPrompt: generationRequests.userPrompt,
      sessionPrompt: activitySessions.userPrompt,
      stylePrompt: generationRequests.stylePrompt,
      expandedPrompt: generationRequests.expandedPrompt,
      styleSnapshot: generationRequests.styleSnapshot,
      genreTags: tracks.genreTags,
      activity: tracks.activity,
      mood: tracks.mood,
      energy: tracks.energy,
      vocalMode: tracks.vocalMode,
      bpmEstimate: tracks.bpmEstimate,
      providerKey: tracks.providerKey,
      providerModel: tracks.providerModel,
      rightsNote: tracks.rightsNote,
      licenseMetadata: tracks.licenseMetadata,
    })
    .from(tracks)
    .innerJoin(user, eq(user.id, tracks.ownerUserId))
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, tracks.ownerUserId))
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .where(and(eq(tracks.id, args.trackId), viewerCanReadTrack(args.viewerUserId)))
    .limit(1);
  if (!row) return null;
  const {
    styleSnapshot,
    rightsNote,
    licenseMetadata,
    artistName,
    userName,
    stampedPrompt,
    sessionPrompt,
    activity,
    mood,
    energy,
    ...details
  } = row;
  return {
    ...details,
    // Provider results write none of these onto the Track, so the request's
    // frozen snapshot is what says what it was made for.
    activity: activity ?? (styleSnapshot?.activity || null),
    mood: mood ?? (styleSnapshot?.mood || null),
    energy: energy ?? (styleSnapshot?.energy || null),
    artistName: resolveArtistName(artistName, userName),
    userPrompt: resolveTrackDataPrompt(stampedPrompt, sessionPrompt),
    language: styleSnapshot?.language || null,
    licenseNote: resolveLicenseNote(rightsNote, licenseMetadata),
  };
}
