// Reads/writes behind a Track's ID3 tags: resolve everything the tag assembly
// needs in one query (track + owning session + effective Session Cover + the
// resolved artist inputs), list a session's / an owner's final MP3s for
// (re)tagging fan-out, and record a retagged file's new size. The worker's
// `embed-track-metadata` job reads one track's context; the download routes read
// a whole zip's worth in one statement to compare against the stored tags.

import { and, eq, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import type { TrackTagContext } from '@liedmotif/shared';
import type { Database } from '../client';
import { withTransaction } from '../transactions';
import { queueOrphanedDownloadDeletion } from './deletion-queue-repo';
import { user } from '../schema/auth';
import {
  resolveArtistName,
  resolveLicenseNote,
  resolveTrackDataPrompt,
} from './track-presentation';
import { effectiveTrackCoverColumn } from '../covers/effective-track-cover';
import {
  activitySessions,
  coverImages,
  generationRequests,
  trackAudioAssets,
  tracks,
  listenerProfiles,
} from '../schema';

/** A `local_original` asset that is (by MIME type or key) an MP3. */
const isMp3LocalOriginal = and(
  eq(trackAudioAssets.assetType, 'local_original'),
  isNotNull(trackAudioAssets.storageKey),
  or(like(trackAudioAssets.mimeType, 'audio/mpeg%'), like(trackAudioAssets.storageKey, '%.mp3')),
);

/**
 * Load the tag context for each of `trackIds` that has local MP3 audio — a
 * missing track, a non-MP3 final, or evicted audio simply yields no row, which
 * is every caller's "nothing to tag". The session/cover legs are LEFT joins: a
 * track that outlived its session still gets text frames. Owner-agnostic; every
 * caller reaches here with track ids it has already authorized.
 */
export async function listTracksForMetadataEmbed(
  db: Database,
  trackIds: string[],
): Promise<TrackTagContext[]> {
  if (trackIds.length === 0) return [];
  const rows = await db
    .select({
      trackId: tracks.id,
      trackTitle: tracks.title,
      sessionTitle: activitySessions.title,
      coverImageId: coverImages.id,
      coverStorageKey: coverImages.storageKey,
      coverBranded: coverImages.branded,
      artistName: listenerProfiles.artistName,
      userName: user.name,
      lyrics: tracks.lyrics,
      genreTags: tracks.genreTags,
      trackCreatedAt: tracks.createdAt,
      bpmEstimate: tracks.bpmEstimate,
      bpmSource: tracks.bpmSource,
      stampedPrompt: generationRequests.userPrompt,
      sessionPrompt: activitySessions.userPrompt,
      stylePrompt: generationRequests.stylePrompt,
      providerModel: tracks.providerModel,
      rightsNote: tracks.rightsNote,
      licenseMetadata: tracks.licenseMetadata,
      // Typed non-null: the join's `isMp3LocalOriginal` guarantees a key.
      audioStorageKey: sql<string>`${trackAudioAssets.storageKey}`,
      audioMimeType: trackAudioAssets.mimeType,
      audioByteSize: trackAudioAssets.byteSize,
    })
    .from(tracks)
    .innerJoin(trackAudioAssets, and(eq(trackAudioAssets.trackId, tracks.id), isMp3LocalOriginal))
    .innerJoin(user, eq(user.id, tracks.ownerUserId))
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, tracks.ownerUserId))
    .leftJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .leftJoin(activitySessions, eq(activitySessions.id, generationRequests.activitySessionId))
    .leftJoin(
      coverImages,
      eq(
        coverImages.id,
        effectiveTrackCoverColumn(activitySessions.coverImageId, tracks.coverImageId),
      ),
    )
    .where(inArray(tracks.id, trackIds));
  return rows.map((row) => ({
    trackId: row.trackId,
    trackTitle: row.trackTitle,
    sessionTitle: row.sessionTitle,
    cover:
      row.coverImageId && row.coverStorageKey
        ? {
            coverImageId: row.coverImageId,
            storageKey: row.coverStorageKey,
            branded: row.coverBranded ?? false,
          }
        : null,
    artist: resolveArtistName(row.artistName, row.userName),
    lyrics: row.lyrics,
    genreTags: row.genreTags,
    trackCreatedAt: row.trackCreatedAt,
    // An anchored (or unsourced) tempo is an estimate from the Session's ask;
    // written as `TBPM` it would read as fact to a DJ tool or music library.
    measuredBpm: row.bpmSource === 'measured' ? row.bpmEstimate : null,
    userPrompt: resolveTrackDataPrompt(row.stampedPrompt, row.sessionPrompt),
    stylePrompt: row.stylePrompt,
    providerModel: row.providerModel,
    licenseNote: resolveLicenseNote(row.rightsNote, row.licenseMetadata),
    audio: {
      storageKey: row.audioStorageKey,
      mimeType: row.audioMimeType,
      byteSize: row.audioByteSize,
    },
  }));
}

/** One track's tag context, or null when it has nothing taggable. */
export async function getTrackForMetadataEmbed(
  db: Database,
  trackId: string,
): Promise<TrackTagContext | null> {
  const [context] = await listTracksForMetadataEmbed(db, [trackId]);
  return context ?? null;
}

/** Track ids in a session that have a local final MP3 (the retag fan-out set). */
export async function listFinalMp3TrackIdsForSession(
  db: Database,
  activitySessionId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ trackId: tracks.id })
    .from(tracks)
    .innerJoin(generationRequests, eq(generationRequests.id, tracks.generationRequestId))
    .innerJoin(trackAudioAssets, and(eq(trackAudioAssets.trackId, tracks.id), isMp3LocalOriginal))
    .where(eq(generationRequests.activitySessionId, activitySessionId));
  return rows.map((row) => row.trackId);
}

/** An owner's track ids with a local final MP3 (artist-name-change retag fan-out). */
export async function listFinalMp3TrackIdsForOwner(
  db: Database,
  ownerUserId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ trackId: tracks.id })
    .from(tracks)
    .innerJoin(trackAudioAssets, and(eq(trackAudioAssets.trackId, tracks.id), isMp3LocalOriginal))
    .where(eq(tracks.ownerUserId, ownerUserId));
  return rows.map((row) => row.trackId);
}

/**
 * Record the retagged local MP3's new byte size on its asset row. The retag
 * publishes outside any transaction, so a delete can drop the asset row and
 * have its queued key deleted while the write is in flight; the published
 * object would then be referenced by nothing. When no asset row names the key
 * any more, the key is queued for deletion again (the consumer's live-key guard
 * keeps it safe). Returns whether the asset row was still there.
 */
export async function updateLocalOriginalByteSize(
  db: Database,
  args: { trackId: string; storageKey: string; byteSize: number },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const updated = await tx
      .update(trackAudioAssets)
      .set({ byteSize: args.byteSize })
      .where(
        and(
          eq(trackAudioAssets.trackId, args.trackId),
          eq(trackAudioAssets.assetType, 'local_original'),
          eq(trackAudioAssets.storageKey, args.storageKey),
        ),
      )
      .returning({ id: trackAudioAssets.id });
    if (updated.length > 0) return true;
    const [owner] = await tx
      .select({ ownerUserId: tracks.ownerUserId })
      .from(tracks)
      .where(eq(tracks.id, args.trackId));
    await queueOrphanedDownloadDeletion(tx, {
      ownerUserId: owner?.ownerUserId ?? '',
      trackId: args.trackId,
      storageKey: args.storageKey,
    });
    return false;
  });
}
