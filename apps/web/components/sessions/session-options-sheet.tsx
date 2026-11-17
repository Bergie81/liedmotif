import { useState } from 'react';
import type { SessionListItem } from '@liedmotif/shared';
import {
  Download,
  ImagePlus,
  ListPlus,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { OfflineMenuRow } from '@/components/offline/offline-menu-row';
import { SheetContent, SheetHeader } from '@/components/ui/sheet';
import { MenuRow } from '@/components/ui/menu-row';
import { MENU_COPY } from '@/components/ui/menu-copy';
import { sessionDownloadUrl, startFileDownload } from '@/lib/downloads';
import { formatGenreLine, formatTrackCount } from './session-list-model';

export function SessionOptionsSheet({
  session,
  resuming,
  deleting,
  converting,
  pinning,
  onResume,
  onTogglePin,
  onRename,
  onChangeCover,
  onConvertToPlaylist,
  onDelete,
}: {
  session: SessionListItem;
  resuming: boolean;
  deleting: boolean;
  converting: boolean;
  pinning: boolean;
  onResume: () => void;
  onTogglePin: () => void;
  /** Open the Rename dialog for this session (the parent owns the dialog). */
  onRename: () => void;
  /** Open the cover dialog for this session (the parent owns the dialog). */
  onChangeCover: () => void;
  onConvertToPlaylist: () => void;
  /** Perform the delete — only ever called confirmed; the modal stays busy until it settles. */
  onDelete: () => Promise<void>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const title = session.title ?? 'Untitled Session';
  const busy = resuming || deleting || converting || pinning;
  return (
    <SheetContent side="bottom" className="overflow-y-auto">
      <SheetHeader
        title={title}
        description={
          formatGenreLine(session.genreTags) ??
          `${formatTrackCount(session.trackCount)} · ready to continue`
        }
      />
      <div className="mt-4">
        <OfflineMenuRow kind="session" id={session.id} />
        <MenuRow
          onlineOnly
          icon={<RotateCcw />}
          label="Resume Session"
          description="Pick up where it left off; a running session stops"
          busy={resuming}
          disabled={busy}
          onClick={onResume}
        />
        <MenuRow
          onlineOnly
          icon={session.pinned ? <PinOff /> : <Pin />}
          label={session.pinned ? 'Unpin Session' : 'Pin Session'}
          description={
            session.pinned
              ? 'Move it back to the regular list'
              : 'Keep it in the pinned section at the top'
          }
          busy={pinning}
          disabled={busy}
          onClick={onTogglePin}
        />
        <MenuRow
          onlineOnly
          icon={<Pencil />}
          label="Rename Session"
          description="Give this session a new name"
          disabled={busy}
          data-testid="rename-session"
          onClick={onRename}
        />
        <MenuRow
          onlineOnly
          icon={<ImagePlus />}
          label="Change Cover Art"
          description="Reroll, upload or pick a previous cover"
          disabled={busy}
          data-testid="change-session-cover"
          onClick={onChangeCover}
        />
        <MenuRow
          onlineOnly
          icon={<ListPlus />}
          label="Convert to Playlist"
          description="Keep the tracks so far as a new playlist; the session stays"
          busy={converting}
          disabled={busy || session.trackCount === 0}
          data-testid="convert-session-to-playlist"
          onClick={onConvertToPlaylist}
        />
        <MenuRow
          onlineOnly
          icon={<Download />}
          label="Download Session"
          description={MENU_COPY.downloadAllTracks}
          disabled={busy || session.trackCount === 0}
          data-testid="download-session"
          onClick={() => startFileDownload(sessionDownloadUrl(session.id))}
        />
        <MenuRow
          onlineOnly
          icon={<Trash2 />}
          label="Delete Session"
          description="Stop it and delete it for good; saved tracks stay"
          tone="danger"
          busy={deleting}
          disabled={busy}
          data-testid="delete-session"
          aria-label={`Delete Session ${title}`}
          onClick={() => setConfirmingDelete(true)}
        />
      </div>
      {confirmingDelete ? (
        <ConfirmDialog
          heading="Delete Session"
          body={`Permanently delete “${title}”? Its unsaved Tracks go with it; Tracks in a Playlist stay in your Library.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await onDelete();
            setConfirmingDelete(false);
          }}
          onClose={() => setConfirmingDelete(false)}
        />
      ) : null}
    </SheetContent>
  );
}
