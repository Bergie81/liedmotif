'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { MAX_SESSION_TITLE_LENGTH, type SessionListItem } from '@liedmotif/shared';
import { usePlayerActions } from '@/components/player/player-provider';
import { RenameDialog } from '@/components/rename-dialog';
import { Sheet } from '@/components/ui/sheet';
import {
  convertSessionToPlaylist,
  deleteSession,
  renameSession,
  resumeSession,
} from '@/lib/http/api-client';
import { toast } from '@/lib/toast';
import { useClientId } from '@/lib/use-client-id';
import { SessionOptionsSheet } from './session-options-sheet';
import type { ResumableSessionsState } from './use-resumable-sessions';
import type { SessionSearch } from './use-session-search';

// The cover sheet pulls in the crop/upload libraries; load it on first open.
const SessionCoverSheet = dynamic(
  () => import('@/components/player/session-cover-sheet').then((m) => m.SessionCoverSheet),
  { ssr: false },
);

const RESUME_KEY = 'session-resume';
const DELETE_KEY = 'session-delete';
const CONVERT_KEY = 'session-convert';

/**
 * The My Sessions options menu and what it acts on: each act lands in both the
 * list and the search results, because the Session may be on screen through
 * either. Stays mounted with nothing selected, since the Rename and cover dialogs
 * outlive the menu that opened them.
 */
export function SessionOptionsFlow({
  selected,
  onClose,
  list,
  search,
}: {
  selected: SessionListItem | null;
  onClose: () => void;
  list: ResumableSessionsState;
  search: SessionSearch;
}) {
  const router = useRouter();
  const clientId = useClientId();
  const { engage, beginOtherMusic } = usePlayerActions();
  const [renaming, setRenaming] = useState<SessionListItem | null>(null);
  const [changingCover, setChangingCover] = useState<SessionListItem | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);

  async function resume(session: SessionListItem) {
    if (!(await beginOtherMusic())) return;
    setResumingId(session.id);
    toast.dismiss(RESUME_KEY);
    const result = await resumeSession(session.id, clientId);
    setResumingId(null);
    if (!result.ok) {
      toast.error(result.error.message, { key: RESUME_KEY });
      return;
    }
    // The page stays put — playback surfaces in the mini player. Refetch the
    // list so the resumed Session moves into the Active now slot (and the
    // previously active one lands under History) without a manual reload.
    engage(result.data.session, { autoplay: true });
    list.retry();
    onClose();
  }

  async function remove(session: SessionListItem) {
    setDeletingId(session.id);
    toast.dismiss(DELETE_KEY);
    const result = await deleteSession(session.id);
    setDeletingId(null);
    if (!result.ok) {
      toast.error(result.error.message, { key: DELETE_KEY });
      return;
    }
    list.removeItem(session.id);
    search.removeResult(session.id);
    router.refresh();
    onClose();
  }

  async function togglePin(session: SessionListItem) {
    setPinningId(session.id);
    const pinnedNow = !session.pinned;
    const accepted = await list.setPinned(session.id, pinnedNow);
    setPinningId(null);
    if (!accepted) return;
    search.patchResult(session.id, { pinned: pinnedNow });
    onClose();
  }

  async function convertToPlaylist(session: SessionListItem) {
    setConvertingId(session.id);
    toast.dismiss(CONVERT_KEY);
    const result = await convertSessionToPlaylist(session.id);
    setConvertingId(null);
    if (!result.ok) {
      toast.error(result.error.message, { key: CONVERT_KEY });
      return;
    }
    onClose();
    // Library would otherwise replay its pre-convert list from the router cache.
    router.refresh();
    router.push(`/library/playlist/${result.data.playlistId}`);
  }

  async function applyRename(session: SessionListItem, title: string): Promise<string | null> {
    const result = await renameSession(session.id, title);
    if (!result.ok) return result.error.message;
    list.updateItem(session.id, { title });
    search.patchResult(session.id, { title });
    router.refresh();
    return null;
  }

  return (
    <>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {selected ? (
          <SessionOptionsSheet
            session={selected}
            resuming={resumingId === selected.id}
            deleting={deletingId === selected.id}
            converting={convertingId === selected.id}
            pinning={pinningId === selected.id}
            onResume={() => void resume(selected)}
            onTogglePin={() => void togglePin(selected)}
            onRename={() => {
              setRenaming(selected);
              onClose();
            }}
            onChangeCover={() => {
              setChangingCover(selected);
              onClose();
            }}
            onConvertToPlaylist={() => void convertToPlaylist(selected)}
            onDelete={() => remove(selected)}
          />
        ) : null}
      </Sheet>

      {renaming ? (
        <RenameDialog
          heading="Rename Session"
          currentName={renaming.title ?? 'Untitled Session'}
          maxLength={MAX_SESSION_TITLE_LENGTH}
          onRename={(title) => applyRename(renaming, title)}
          onClose={() => setRenaming(null)}
        />
      ) : null}

      {changingCover ? (
        <SessionCoverSheet
          open
          onClose={() => setChangingCover(null)}
          sessionId={changingCover.id}
          sessionTitle={changingCover.title ?? 'Untitled Session'}
          coverImageId={changingCover.coverImageId}
          onCoverChanged={(coverImageId) => {
            list.updateItem(changingCover.id, { coverImageId });
            search.patchResult(changingCover.id, { coverImageId });
          }}
        />
      ) : null}
    </>
  );
}
