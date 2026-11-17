'use client';

import { Trash2 } from 'lucide-react';
import { dangerButtonClass } from '@/components/ui/design-system';
import { toast } from '@/lib/toast';
import { useCredentialMutationGate } from './credential-mutation-group';

interface StoredLlmCredentialActionProps {
  providerKey: string;
  environmentActive: boolean;
}

export function StoredLlmCredentialAction({
  providerKey,
  environmentActive,
}: StoredLlmCredentialActionProps) {
  const gate = useCredentialMutationGate();
  const deleting = gate.pending === 'delete';
  const label = environmentActive ? 'Delete stored fallback' : 'Disable Writing AI';

  async function remove() {
    if (!gate.begin('delete')) return;
    try {
      const consequence = environmentActive
        ? 'The environment-selected Writing AI will remain active.'
        : 'Sessions keep working: your words will reach the music model exactly as written, without AI expansion.';
      if (!window.confirm(`${label}? ${consequence}`)) return;

      const response = await fetch('/api/settings/credentials', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: 'llm', providerKey }),
      }).catch(() => null);
      const body = response
        ? ((await response.json().catch(() => ({}))) as {
            ok?: boolean;
            error?: string | { message?: string };
          })
        : {};
      if (response?.ok && body.ok) {
        toast.dismiss('stored-llm-delete');
        window.location.reload();
        return;
      }
      const message = typeof body.error === 'string' ? body.error : body.error?.message;
      toast.error(message ?? 'Could not remove the stored Writing AI.', {
        key: 'stored-llm-delete',
      });
    } finally {
      gate.end('delete');
    }
  }

  return (
    <div className="border-t border-line pt-4">
      {environmentActive ? (
        <p className="mb-3 text-[12.5px] text-dim">
          This removes only the encrypted database fallback. Server environment settings keep
          winning.
        </p>
      ) : null}
      <button
        type="button"
        onClick={remove}
        disabled={gate.pending !== null}
        className={`${dangerButtonClass} mt-3 w-full`}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        {deleting ? 'Removing…' : label}
      </button>
    </div>
  );
}
