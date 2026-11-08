'use client';

// The one naming modal: the player options sheet (Session and Track)
// and the My Sessions options sheet rename through it, and a create flow asks
// for a first name through it with an empty `currentName`. Renaming is one-way:
// the input starts from the current name, a blank submit is blocked (there is no
// reset path — nothing retains the derived name), and the caller performs the
// actual API write so this component stays a pure name-editing surface. Mounted
// only while open — the caller holds the target and drops it on close, which is
// also what pins the target when playback advances mid-edit.

import { useState, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/design-system';
import {
  Dialog,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';

export function RenameDialog({
  heading,
  currentName,
  maxLength,
  confirmLabel = 'Rename',
  busyLabel = 'Renaming…',
  onRename,
  onClose,
}: {
  /** What is being renamed, e.g. "Rename Session" / "Rename Track". */
  heading: string;
  currentName: string;
  maxLength: number;
  /** Submit-button labels; create flows pass "Create" / "Creating…". */
  confirmLabel?: string;
  busyLabel?: string;
  /** Perform the rename; resolve to an error message, or null on success. */
  onRename: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onRename(trimmed);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="rename-dialog" aria-describedby={undefined}>
        <DialogCloseButton />

        <div className="px-8 text-center">
          {/* A create flow has no current name — the heading IS the title then. */}
          {currentName ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-lamp">{heading}</p>
          ) : null}
          <DialogTitle className="mt-1 truncate font-display text-[22px] font-extrabold leading-[1.2] tracking-[-0.02em] text-paper">
            {currentName || heading}
          </DialogTitle>
        </div>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={maxLength}
            autoFocus
            aria-label="New name"
            data-testid="rename-input"
            className={inputClass}
          />
          {error ? <AlertBanner data-testid="rename-error">{error}</AlertBanner> : null}
          <div className="flex items-stretch gap-2">
            <button
              type="submit"
              data-testid="rename-save"
              disabled={busy || !trimmed}
              className={cn(primaryButtonClass, 'flex-1')}
            >
              {busy ? busyLabel : confirmLabel}
            </button>
            <DialogClose className={secondaryButtonClass}>Cancel</DialogClose>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
