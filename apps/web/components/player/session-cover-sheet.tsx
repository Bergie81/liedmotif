'use client';

// A Session's cover in the shared cover sheet, opened from the player's
// Session options and from a My Sessions card. The style starts on the
// Session's own and a changed one sticks; People photos are asked for per
// attempt, as on a Playlist.

import { useState } from 'react';
import {
  COVER_STYLE_CHOICES,
  MAX_SESSION_COVER_HISTORY,
  type CoverStyleChoice,
} from '@liedmotif/shared';
import {
  deleteSessionCover,
  getSessionCoverStatus,
  regenerateSessionCover,
  selectSessionCover,
  uploadSessionCover,
  type SessionCoverStatusData,
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
import { CoverArt, CoverFallback } from './cover-art';

const SESSION_COVER_API: CoverApi<SessionCoverStatusData> = {
  status: getSessionCoverStatus,
  select: selectSessionCover,
  upload: uploadSessionCover,
  remove: deleteSessionCover,
};

export function SessionCoverSheet({
  open,
  onClose,
  sessionId,
  sessionTitle,
  coverImageId,
  onCoverChanged,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  sessionTitle: string;
  /** The caller's current cover, shown until the status answers. */
  coverImageId: string | null;
  /** A saved swap, so a caller that renders the cover itself can follow it. */
  onCoverChanged?: (coverImageId: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      {open ? (
        <SessionCoverContent
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          coverImageId={coverImageId}
          onClose={onClose}
          onCoverChanged={onCoverChanged}
        />
      ) : null}
    </Sheet>
  );
}

function SessionCoverContent({
  sessionId,
  sessionTitle,
  coverImageId,
  onClose,
  onCoverChanged,
}: {
  sessionId: string;
  sessionTitle: string;
  coverImageId: string | null;
  onClose: () => void;
  onCoverChanged?: (coverImageId: string) => void;
}) {
  /** null = untouched: the pick then mirrors the Session's stored style. */
  const [styleChoice, setStyleChoice] = useState<CoverStyleChoice | null>(null);
  const [guidance, setGuidance] = useState('');
  const [usePeople, setUsePeople] = useState(true);

  return (
    <CoverSheetContent
      kind="Session"
      title={sessionTitle}
      subjectId={sessionId}
      initialCoverImageId={coverImageId}
      maxHistory={MAX_SESSION_COVER_HISTORY}
      api={SESSION_COVER_API}
      onCoverChanged={(changed) => {
        if (changed) onCoverChanged?.(changed);
      }}
      onClose={onClose}
      renderCover={(id, size) => (
        <CoverArt
          coverImageId={id}
          thumb={size === 'thumb'}
          className="h-full w-full object-cover"
          fallback={<CoverFallback iconClassName={size === 'thumb' ? 'h-6 w-6' : 'h-14 w-14'} />}
        />
      )}
      generate={(status) =>
        regenerateSessionCover(sessionId, {
          ...(styleChoice ? { coverStyle: styleChoice } : {}),
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
          ...peopleReferencesRequest(status, usePeople),
        })
      }
      renderFields={({ status, disabled }) => (
        <>
          <CoverStyleField
            choices={COVER_STYLE_CHOICES}
            value={styleChoice ?? status?.coverStyle ?? 'auto'}
            onChange={setStyleChoice}
            disabled={disabled}
            testId="session-cover-style"
            note="A changed style becomes this session’s style going forward."
          />
          <ArtDirectionField
            value={guidance}
            onChange={setGuidance}
            disabled={disabled}
            testId="session-cover-guidance"
          />
          <PeopleReferencesField
            status={status}
            checked={usePeople}
            onChange={setUsePeople}
            disabled={disabled}
            namedIn="this session’s prompt"
            ownerNote="unless it runs without your profile details"
            testId="session-cover-use-people"
          />
        </>
      )}
    />
  );
}
