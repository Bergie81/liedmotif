'use client';

// Where a listener chooses how much new music a Session may buy. The server
// keeps that as two values, the Session mode and the duration target; here it
// is one choice. Off buys nothing, so it applies on the tap. Anything that can
// spend waits for Save.

import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@liedmotif/shared';
import { useAppChrome } from '@/components/app-chrome-context';
import {
  deriveGenerationHeadroom,
  headroomLine,
  type GenerationHeadroom,
} from '@/components/app-shell-model';
import { SessionDurationControl } from '@/components/create/session-duration-control';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { OnlineOnly } from '@/components/ui/online-only';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { setSessionMode } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import {
  NEW_MUSIC_CHOICES,
  NEW_MUSIC_SAVING,
  newMusicSaveLabel,
  type NewMusicChoice,
} from './new-music-choices';
import { NEW_MUSIC_ICONS } from './new-music-icons';
import type { NewMusicStatus } from './new-music-status';
import { switchNewMusicOn } from './switch-new-music-on';

const DEFAULT_TARGET_MINUTES = 60;
const MIN_TARGET_MINUTES = 5;

const CHOICE_ORDER: readonly NewMusicChoice[] = ['off', 'target', 'no-limit'];

const SAVE_FAILED_KEY = 'new-music-save';

function choiceInForce(session: SessionSummary): NewMusicChoice {
  if (session.sessionMode === 'repeat') return 'off';
  return session.targetDurationMinutes != null ? 'target' : 'no-limit';
}

function allowanceLine(headroom: GenerationHeadroom | null): string {
  return headroom ? ` · ${headroomLine(headroom)}` : '';
}

/** Mounted only while the sheet is up, so each opening starts from what is in force. */
function NewMusicPanel({
  session,
  generatedLine,
  available,
  saving,
  onSavingChange,
  onClose,
  onSessionChange,
}: {
  session: SessionSummary;
  generatedLine: string;
  available: boolean;
  saving: boolean;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSessionChange: (session: SessionSummary) => void;
}) {
  const inForce = choiceInForce(session);
  const [choice, setChoice] = useState(inForce);
  const [minutes, setMinutes] = useState(session.targetDurationMinutes ?? DEFAULT_TARGET_MINUTES);
  const [headroom, setHeadroom] = useState<GenerationHeadroom | null>(null);

  // The sheet cannot be dismissed mid-save, so a reply that finds this panel
  // gone belongs to a Session the player is no longer showing.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { fetchChrome } = useAppChrome();
  useEffect(() => {
    void fetchChrome().then((result) => {
      if (mounted.current && result.ok) setHeadroom(deriveGenerationHeadroom(result.data.usage));
    });
  }, [fetchChrome]);

  async function commit(next: NewMusicChoice) {
    onSavingChange(true);
    const result =
      next === 'off'
        ? await setSessionMode(session.id, 'repeat')
        : await switchNewMusicOn(session.id, next === 'target' ? minutes : null);
    if (!mounted.current) return;
    onSavingChange(false);
    if (!result.ok) {
      toast.error(result.error.message, { key: SAVE_FAILED_KEY });
      setChoice(inForce);
      return;
    }
    toast.dismiss(SAVE_FAILED_KEY);
    onSessionChange(result.data.session);
    onClose();
  }

  function choose(next: NewMusicChoice) {
    setChoice(next);
    if (next === 'off' && inForce !== 'off') void commit('off');
  }

  const needsSave =
    choice !== 'off' &&
    (choice !== inForce || (choice === 'target' && minutes !== session.targetDurationMinutes));

  return (
    <OnlineOnly>
      <div className="mt-4 space-y-2" role="group" aria-label="New music">
        {CHOICE_ORDER.map((id) => {
          const { label, detail } = NEW_MUSIC_CHOICES[id];
          const selected = choice === id;
          const Icon = NEW_MUSIC_ICONS[id];
          return (
            <div
              key={id}
              className={cn(
                'rounded-[13px] border border-line-2 bg-[var(--control-bg)]',
                selected && 'border-lamp/55 bg-lamp/[0.08]',
              )}
            >
              <button
                type="button"
                aria-pressed={selected}
                disabled={!available || saving}
                onClick={() => choose(id)}
                className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Icon
                  aria-hidden
                  className={cn('h-5 w-5 shrink-0', selected ? 'text-lamp' : 'text-muted')}
                />
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{label}</span>
                  <span className="block text-[12px] text-muted">{detail}</span>
                </span>
              </button>
              {id === 'target' && selected ? (
                <div className="px-4 pb-4">
                  <SessionDurationControl
                    value={minutes}
                    onChange={(value) => setMinutes(value ?? MIN_TARGET_MINUTES)}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div data-testid="new-music-facts" className="mt-4 text-[12px] leading-[1.6] text-muted">
        <p>
          {generatedLine}
          {allowanceLine(headroom)}
        </p>
        <p className="text-dim">Only generates while you listen.</p>
      </div>
      {needsSave ? (
        <button
          type="button"
          disabled={!available || saving}
          onClick={() => void commit(choice)}
          className={cn(primaryButtonClass, 'mt-4 w-full')}
        >
          {saving ? NEW_MUSIC_SAVING : newMusicSaveLabel(choice === 'target' ? minutes : null)}
        </button>
      ) : null}
    </OnlineOnly>
  );
}

export function NewMusicSheet({
  session,
  status,
  open,
  onOpenChange,
  available,
  onSessionChange,
}: {
  session: SessionSummary;
  status: NewMusicStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether this player may write the Session's policy right now. */
  available: boolean;
  onSessionChange: (session: SessionSummary) => void;
}) {
  // Held here because the panel goes when the sheet closes: a save must finish
  // in the open, where its result or refusal can be seen.
  const [saving, setSaving] = useState(false);

  function handleOpenChange(next: boolean) {
    if (!saving) onOpenChange(next);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="bottom" className="overflow-y-auto">
        <SheetHeader title="New music" description={status.sentence} closeDisabled={saving} />
        <NewMusicPanel
          session={session}
          generatedLine={status.generatedLine}
          available={available}
          saving={saving}
          onSavingChange={setSaving}
          onClose={() => onOpenChange(false)}
          onSessionChange={onSessionChange}
        />
      </SheetContent>
    </Sheet>
  );
}
