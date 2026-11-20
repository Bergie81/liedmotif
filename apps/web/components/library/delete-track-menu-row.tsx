'use client';

// The one Delete Track act every track kebab offers: a danger row that never
// deletes on the first tap — the confirm dialog owns the destructive commit,
// and it lives here WITH the row so no surface can wire the row straight to
// the delete (an explicit delete is never feedback).

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { MenuRow } from '@/components/ui/menu-row';

export function DeleteTrackMenuRow({
  title,
  testId,
  busy = false,
  disabled = false,
  onDelete,
}: {
  /** The Track's display title, named in the confirm body. */
  title: string;
  testId: string;
  busy?: boolean;
  disabled?: boolean;
  /** Perform the delete — only ever called confirmed; the dialog stays busy
   *  until it settles. */
  onDelete: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <MenuRow
        onlineOnly
        icon={<Trash2 />}
        label="Delete Track"
        description="Delete its audio for good, from every playlist and your Library"
        tone="danger"
        busy={busy}
        disabled={disabled}
        data-testid={testId}
        onClick={() => setConfirming(true)}
      />
      {confirming ? (
        <ConfirmDialog
          heading="Delete Track"
          body={`Permanently delete “${title}”? Its audio is removed from storage and it leaves every playlist and your Library; this is not feedback and steers nothing.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await onDelete();
            setConfirming(false);
          }}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </>
  );
}
