'use client';

import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@liedmotif/shared';
import { SessionDurationControl } from '@/components/create/session-duration-control';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { setSessionDuration } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { SessionDurationProgress } from './session-duration-progress';

export function SessionDurationEditor({
  session,
  onSessionChange,
}: {
  session: SessionSummary;
  onSessionChange: (session: SessionSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<number | null>(session.targetDurationMinutes ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A save that lands after the player moved to another Session must not apply.
  const epoch = useRef(0);
  useEffect(() => {
    setOpen(false);
    setSaving(false);
    return () => {
      epoch.current += 1;
    };
  }, [session.id]);

  function openEditor() {
    setTarget(session.targetDurationMinutes ?? null);
    setError(null);
    setOpen(true);
  }

  async function save() {
    if (saving) return;
    const started = epoch.current;
    setSaving(true);
    setError(null);
    const result = await setSessionDuration(session.id, target);
    if (epoch.current !== started) return;
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSessionChange(result.data.session);
    setOpen(false);
  }

  return (
    <>
      <SessionDurationProgress session={session} onEdit={openEditor} />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom">
          <SheetHeader
            title="Session duration"
            description="Limit how much music this Session generates. Existing Tracks keep playing and repeat when the target is reached."
          />
          <div className="mt-4">
            <SessionDurationControl value={target} onChange={setTarget} />
          </div>
          <p className="mt-2 text-[11.5px] leading-[1.5] text-dim">
            No limit keeps your selected generation mode.
          </p>
          {error ? (
            <p role="alert" className="mt-2 text-[12px] text-warn">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className={cn(primaryButtonClass, 'mt-4 w-full')}
          >
            {saving ? 'Saving…' : 'Save duration'}
          </button>
        </SheetContent>
      </Sheet>
    </>
  );
}
