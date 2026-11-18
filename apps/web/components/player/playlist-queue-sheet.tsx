'use client';

// The playing Playlist's ordered list — the flat, non-generative counterpart
// of the Session tracks sheet, opened from the same transport slot. No states to
// narrate (every member is a finished Track): just the order, the current row
// highlighted, tap to jump. Navigation is never feedback.

import type { PlaylistMemberItem } from '@liedmotif/shared';
import { FAILED_TRACK_NOTICE, formatTrackDuration } from '@/components/library/library-view-model';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { QueueRow, queueEmptyNoteClass } from './queue-row';

type QueueSheetTrack = Pick<
  PlaylistMemberItem,
  'id' | 'title' | 'coverImageId' | 'durationSeconds' | 'audioUrl'
> &
  Partial<Pick<PlaylistMemberItem, 'status'>> & {
    /** Its offline copy expired on this device: listed, never started. */
    expired?: boolean;
  };

/** The row's mono line: why it cannot play, else its length. */
function queueRowNote(member: QueueSheetTrack): string {
  if (member.status === 'failed') return FAILED_TRACK_NOTICE;
  if (member.expired) return 'Expired';
  return formatTrackDuration(member.durationSeconds);
}

export function PlaylistQueueSheet({
  open,
  onOpenChange,
  playlistName,
  tracks,
  currentTrackId,
  onPlayTrack,
}: {
  /** Parent-owned, like the player's other sheets — the transport opens it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playlistName: string;
  tracks: QueueSheetTrack[];
  currentTrackId: string | null;
  onPlayTrack: (trackId: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="overflow-y-auto" data-testid="playlist-queue">
        <SheetHeader
          title={playlistName}
          description="Playback order — tap a Track to jump to it."
          closeLabel={`Close tracks in ${playlistName}`}
        />
        {tracks.length === 0 ? (
          <p className={queueEmptyNoteClass}>This Playlist has no Tracks left to play.</p>
        ) : null}
        <ol className="mt-4">
          {tracks.map((member) => {
            const current = member.id === currentTrackId;
            const title = member.title ?? 'Untitled Track';
            return (
              <QueueRow
                key={member.id}
                title={title}
                coverImageId={member.coverImageId}
                playing={current}
                onPlay={
                  member.audioUrl && !member.expired ? () => onPlayTrack(member.id) : undefined
                }
              >
                <span
                  className={cn(
                    'block min-w-0 truncate text-[14.5px] font-semibold',
                    current && 'text-lamp',
                  )}
                >
                  {title}
                </span>
                <span className="font-mono text-[10.5px] tracking-[0.04em] text-dim">
                  {queueRowNote(member)}
                </span>
              </QueueRow>
            );
          })}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
