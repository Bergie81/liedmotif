'use client';

// A member's own acts. The sheet names the Track before acting on it — cover,
// title, and the row's own mono line — the way every other track menu in the
// app opens. Remove is the Playlist's act on the Track and sits first because
// it is what this menu is reached for; it never unsaves while another
// membership remains.

import { Download, Info, Minus, Plus } from 'lucide-react';
import { MenuMoreLikeThisGlyph } from '@/components/ui/glyphs';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { MenuRow } from '@/components/ui/menu-row';
import { startFileDownload, trackDownloadUrl } from '@/lib/downloads/downloads';
import { CoverThumb } from '@/components/player/cover-art';
import { DeleteTrackMenuRow } from '@/components/library/delete-track-menu-row';
import { trackDownloadNote } from '@/components/library/library-view-model';
import { formatPlaylistMemberMetadata } from './playlist-view-model';

export function PlaylistTrackSheet({
  item,
  visitor = false,
  onClose,
  onRemove,
  onAddToPlaylist,
  onMoreLikeThis,
  onOpenTrackData,
  onDelete,
}: {
  /** The member the sheet is about; null closes it. */
  item: PlaylistMemberItem | null;
  /** A member on the Lounge visitor view: reading and saving the
   *  reference remain — the owner's curation, seeding and downloads are
   *  absent, not disabled. */
  visitor?: boolean;
  onClose: () => void;
  onRemove: (item: PlaylistMemberItem) => void;
  /** Hands off to the save picker, where this Track's whole membership is set. */
  onAddToPlaylist: (item: PlaylistMemberItem) => void;
  /** Start a NEW Session seeded from THIS Track. */
  onMoreLikeThis: (item: PlaylistMemberItem) => void;
  /** Hands off to the Track Data sheet — parent-owned, so two never stack. */
  onOpenTrackData: (item: PlaylistMemberItem) => void;
  /** Permanently delete the Track everywhere — only ever called confirmed. */
  onDelete: (item: PlaylistMemberItem) => Promise<void> | void;
}) {
  const title = item?.title ?? 'Untitled Track';
  // A foreign track: a Lounge member, or a Shared reference inside
  // the reader's own playlist (`owner` attribution set). Only its own owner may
  // download or destroy it — those rows are absent, never disabled. The
  // reference's membership in MY playlist stays mine to remove, and More Like
  // This stays the reader's own act: a new Session on THEIR budget, seeded from
  // the shared style stripped of the owner's personal ingredients.
  const foreign = visitor || item?.owner != null;
  return (
    <Sheet open={item !== null} onOpenChange={(next) => !next && onClose()}>
      {item ? (
        <SheetContent side="bottom" className="overflow-y-auto" data-testid="playlist-track-sheet">
          <SheetHeader
            leading={<CoverThumb coverImageId={item.coverImageId} />}
            title={title}
            description={
              <span className="font-mono text-[10.5px] tracking-[0.04em] text-dim">
                {formatPlaylistMemberMetadata(item)}
              </span>
            }
            closeLabel={`Close options for ${title}`}
          />
          <div className="mt-4" role="group" aria-label="Track options">
            {visitor ? null : (
              <MenuRow
                onlineOnly
                icon={<Minus />}
                label="Remove from Playlist"
                description="It leaves your library if this is its only playlist"
                data-testid="playlist-remove-track"
                onClick={() => onRemove(item)}
              />
            )}
            {/* Saving stays for a foreign track: it files a Shared reference
                into the reader's OWN playlists. */}
            <MenuRow
              onlineOnly
              icon={<Plus />}
              label="Add to Playlist"
              description="Choose which playlists it belongs to"
              data-testid="playlist-add-track-to-playlist"
              onClick={() => onAddToPlaylist(item)}
            />
            <MenuRow
              onlineOnly
              icon={<MenuMoreLikeThisGlyph />}
              label="More Like This"
              description={
                foreign
                  ? 'Start a new session seeded from this track, on your own budget'
                  : 'Start a new session seeded from this track'
              }
              data-testid="playlist-track-more-like-this"
              onClick={() => onMoreLikeThis(item)}
            />

            <MenuRow
              icon={<Info />}
              label="Track Data"
              description="See everything this track was generated from"
              data-testid="playlist-track-data"
              onClick={() => onOpenTrackData(item)}
            />
            {foreign ? null : (
              <>
                <MenuRow
                  onlineOnly
                  icon={<Download />}
                  label="Download Track"
                  description="Save this track as a fully tagged MP3"
                  note={trackDownloadNote(item)}
                  disabled={!item.downloadable}
                  data-testid="playlist-download-track"
                  onClick={() => startFileDownload(trackDownloadUrl(item.id))}
                />
                <DeleteTrackMenuRow
                  title={title}
                  testId="playlist-delete-track"
                  onDelete={() => onDelete(item)}
                />
              </>
            )}
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
