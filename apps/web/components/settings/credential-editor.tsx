'use client';

import { cn } from '@/lib/cn';
import type { LockedModel } from '@/lib/configurable-providers';
import { compactPrimaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { BaseUrlField, ModelField, ProviderChoice, SecretField } from './credential-fields';
import {
  useCredentialEditor,
  type CredentialEditorProps,
  type ProviderOption,
} from './use-credential-editor';

export type { CredentialEditorProps, ProviderOption };

export function CredentialEditor({
  lockedModel,
  ...props
}: Omit<CredentialEditorProps, 'onSaved'> & { lockedModel?: LockedModel }) {
  // Settings reloads after a save so the server-rendered credential status — source,
  // masked preview, health — is re-resolved rather than guessed at client-side.
  const editor = useCredentialEditor({ ...props, onSaved: () => window.location.reload() });

  return (
    <div className="flex flex-col gap-4">
      <ProviderChoice editor={editor} options={props.options} />
      <SecretField editor={editor} currentMasked={props.sharesKey ? null : props.currentMasked} />
      <BaseUrlField editor={editor} />
      {props.showModel ? <ModelField editor={editor} locked={lockedModel} /> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={editor.test}
          disabled={editor.operationPending || !editor.canTest}
          aria-busy={editor.testing}
          className={secondaryButtonClass}
        >
          {editor.testing ? <LiedmotifLoader size="xs" /> : null}
          {editor.testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          onClick={editor.save}
          disabled={editor.operationPending || !props.databaseWritesEnabled}
          aria-busy={editor.saving}
          className={cn(compactPrimaryButtonClass, 'flex-1')}
        >
          {editor.saving ? <LiedmotifLoader size="xs" /> : null}
          {editor.saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
