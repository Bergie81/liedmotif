'use client';

// A Playlist's cover in the shared cover sheet: its derived mosaic is the look
// without a custom cover (offered as Mosaic View), the styles are the Session
// ones without Auto, and People photos are asked for per attempt.

import { useState } from 'react';
import {
  MAX_PLAYLIST_COVER_HISTORY,
  PLAYLIST_COVER_STYLE_CHOICES,
  type PlaylistCoverStyleChoice,
  type PlaylistSummaryItem,
} from '@liedmotif/shared';
import {
  deletePlaylistCover,
  playlistCoverStatus,
  regeneratePlaylistCover,
  selectPlaylistCover,
  uploadPlaylistCover,
  type PlaylistCoverStatusData,
} from '@/lib/http/api-client';
import {
  ArtDirectionField,
  CoverSheetContent,
  CoverStyleField,
  PeopleReferencesField,
  peopleReferencesRequest,
  type CoverApi,
} from '@/components/covers/cover-sheet';
import { Sheet } from '@/components/ui/sheet';
import { PlaylistCover } from './playlist-cover';

const PLAYLIST_COVER_API: CoverApi<PlaylistCoverStatusData> = {
  status: playlistCoverStatus,
  select: selectPlaylistCover,
  selectMosaic: (playlistId) => selectPlaylistCover(playlistId, null),
  upload: uploadPlaylistCover,
  remove: deletePlaylistCover,
};

export function PlaylistCoverSheet({
  playlist,
  open,
  onClose,
  onCoverChanged,
}: {
  playlist: PlaylistSummaryItem;
  open: boolean;
  onClose: () => void;
  /** The playlist's custom-cover pointer changed (null = back to the mosaic). */
  onCoverChanged: (coverImageId: string | null) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <PlaylistCoverContent
          playlist={playlist}
          onClose={onClose}
          onCoverChanged={onCoverChanged}
        />
      ) : null}
    </Sheet>
  );
}

function PlaylistCoverContent({
  playlist,
  onClose,
  onCoverChanged,
}: {
  playlist: PlaylistSummaryItem;
  onClose: () => void;
  onCoverChanged: (coverImageId: string | null) => void;
}) {
  /** A Playlist persists no style of its own, so every sheet opens on Random. */
  const [styleChoice, setStyleChoice] = useState<PlaylistCoverStyleChoice>('random');
  const [guidance, setGuidance] = useState('');
  const [usePeople, setUsePeople] = useState(true);

  return (
    <CoverSheetContent
      kind="Playlist"
      title={playlist.name}
      subjectId={playlist.id}
      initialCoverImageId={playlist.coverImageId}
      maxHistory={MAX_PLAYLIST_COVER_HISTORY}
      api={PLAYLIST_COVER_API}
      onCoverChanged={onCoverChanged}
      onClose={onClose}
      renderCover={(coverImageId, size) => (
        <PlaylistCover
          coverImageId={coverImageId}
          mosaicCoverImageIds={playlist.mosaicCoverImageIds}
          thumb={size === 'thumb'}
          className="h-full w-full"
        />
      )}
      generate={(status) =>
        regeneratePlaylistCover({
          playlistId: playlist.id,
          coverStyle: styleChoice,
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
          ...peopleReferencesRequest(status, usePeople),
        })
      }
      renderFields={({ status, disabled }) => (
        <>
          <CoverStyleField
            choices={PLAYLIST_COVER_STYLE_CHOICES}
            value={styleChoice}
            onChange={setStyleChoice}
            disabled={disabled}
            testId="playlist-cover-style"
          />
          <ArtDirectionField
            value={guidance}
            onChange={setGuidance}
            disabled={disabled}
            testId="playlist-cover-guidance"
          />
          <PeopleReferencesField
            status={status}
            checked={usePeople}
            onChange={setUsePeople}
            disabled={disabled}
            namedIn="this playlist’s name"
            testId="playlist-cover-use-people"
          />
        </>
      )}
    />
  );
}
