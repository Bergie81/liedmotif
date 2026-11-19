'use client';

// A Session's cover in the shared cover sheet, opened from the player's
// Session options and from a My Sessions card. The style starts on the
// Session's own and a changed one sticks; the art direction can start from
// the Session prompt, and the Text AI may enhance it when one is configured.

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
  CoverToggleRow,
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
  /** null = untouched: the switch then mirrors the global setting. */
  const [enhanceChoice, setEnhanceChoice] = useState<boolean | null>(null);

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
      generate={() =>
        regenerateSessionCover(sessionId, {
          ...(styleChoice ? { coverStyle: styleChoice } : {}),
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
          // A flipped switch overrides the global setting for this attempt only.
          ...(enhanceChoice === null ? {} : { enhance: enhanceChoice }),
        })
      }
      renderFields={({ status, disabled }) => {
        const enhanceActive = enhanceChoice ?? status?.promptEnhancement.active ?? false;
        const sessionPrompt = status?.sessionPrompt ?? null;
        return (
          <>
            <CoverStyleField
              choices={COVER_STYLE_CHOICES}
              value={styleChoice ?? status?.coverStyle ?? 'auto'}
              onChange={setStyleChoice}
              disabled={disabled}
              testId="session-cover-style"
              note="A changed style becomes this Session’s style going forward."
            />
            <ArtDirectionField
              value={guidance}
              onChange={setGuidance}
              disabled={disabled}
              testId="session-cover-guidance"
              hint="Name someone from People to put their photo on the cover."
              action={
                sessionPrompt ? (
                  <button
                    type="button"
                    data-testid="use-session-prompt"
                    disabled={disabled}
                    onClick={() => setGuidance(sessionPrompt)}
                    className="rounded-full border border-line px-3 py-1.5 text-[11.5px] font-medium text-muted transition-colors duration-[120ms] hover:border-lamp/50 hover:text-paper"
                  >
                    Use session prompt
                  </button>
                ) : null
              }
            />
            {status?.promptEnhancement.llmConfigured ? (
              <CoverToggleRow
                label="Enhance prompt with the Text AI"
                hint={
                  enhanceActive
                    ? 'Optimized automatically by your Text AI.'
                    : 'Sent to the image model exactly as written.'
                }
                checked={enhanceActive}
                onChange={setEnhanceChoice}
                disabled={disabled}
                testId="session-cover-enhance"
                hintTestId="enhancement-note"
              />
            ) : null}
          </>
        );
      }}
    />
  );
}
