'use client';

// A small shared confirm modal for destructive actions whose consequence needs
// a sentence (not just a second tap) — e.g. deleting a Playlist names how many
// member Tracks would leave the Library.

import { useState } from 'react';
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';

export function ConfirmDialog({
  heading,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
}: {
  heading: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Perform the action; the dialog stays open (busy) until it settles. */
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    await onConfirm();
    setBusy(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-testid="confirm-dialog" aria-describedby={undefined}>
        <DialogCloseButton disabled={busy} />
        <DialogTitle className="pr-8 font-display text-[18px] font-bold tracking-[-0.01em]">
          {heading}
        </DialogTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{body}</p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            className={cn(secondaryButtonClass, 'flex-1')}
            disabled={busy}
            onClick={onClose}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid="confirm-dialog-confirm"
            className={cn(primaryButtonClass, 'flex-1')}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
