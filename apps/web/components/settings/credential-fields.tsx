// The controls a provider credential is edited with, shared by Settings →
// Providers and the first-login onboarding steps. Both surfaces arrange them
// differently, but neither gets to word them differently.

'use client';

import { useId } from 'react';
import { cn } from '@/lib/cn';
import type { LockedModel } from '@/lib/configurable-providers';
import { segmentedListClass, segmentedTriggerClass } from '@/components/ui/design-system';
import { inputClass, labelClass } from '@/components/ui/form-styles';
import { SettingsFeedback } from './settings-ui';
import type { CredentialEditorState, ProviderOption } from './use-credential-editor';

export function ProviderChoice({
  editor,
  options,
}: {
  editor: CredentialEditorState;
  options: readonly ProviderOption[];
}) {
  if (options.length <= 1) return null;
  return (
    <div className={labelClass}>
      <span>Provider</span>
      <div className={cn(segmentedListClass, 'overflow-x-auto')} role="group">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            data-state={editor.providerKey === option.value ? 'active' : 'inactive'}
            aria-pressed={editor.providerKey === option.value}
            onClick={() => editor.selectProvider(option.value)}
            disabled={editor.operationPending}
            className={cn(segmentedTriggerClass, 'min-w-[92px]')}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SecretField({
  editor,
  label = 'API key',
  placeholder = 'sk-…',
  currentMasked,
}: {
  editor: CredentialEditorState;
  label?: string;
  placeholder?: string;
  /** A stored key's preview; its presence is what makes a blank field mean "keep". */
  currentMasked: string | null;
}) {
  if (!editor.selected?.needsKey) return null;
  return (
    <label className={labelClass}>
      <span className="flex items-baseline justify-between gap-2">
        {label}
        {currentMasked ? <FieldNote>LEAVE BLANK TO KEEP</FieldNote> : null}
      </span>
      <input
        type="password"
        value={editor.secret}
        onChange={(event) => editor.setSecret(event.target.value)}
        className={inputClass}
        placeholder={placeholder}
        autoComplete="off"
        disabled={editor.operationPending}
      />
    </label>
  );
}

export function BaseUrlField({ editor }: { editor: CredentialEditorState }) {
  if (!editor.selected?.needsBaseUrl) return null;
  return (
    <label className={labelClass}>
      Base URL
      <input
        type="url"
        value={editor.baseUrl}
        onChange={(event) => editor.setBaseUrl(event.target.value)}
        className={inputClass}
        placeholder={editor.selected.baseUrlPlaceholder ?? 'https://…'}
        disabled={editor.operationPending}
      />
    </label>
  );
}

export function ModelField({
  editor,
  locked,
}: {
  editor: CredentialEditorState;
  locked?: LockedModel;
}) {
  const fallback = editor.selected?.defaultModel;
  const listId = useId();
  if (locked) {
    return (
      <label className={labelClass}>
        <span className="flex items-baseline justify-between gap-2">
          Model
          <FieldNote>SET BY {locked.variable}</FieldNote>
        </span>
        <input value={locked.model} className={inputClass} readOnly spellCheck={false} />
      </label>
    );
  }
  const suggestions = editor.discoveredModels;
  const placeholder =
    fallback ??
    (editor.selected?.listsModels && suggestions.length === 0
      ? 'Test the connection to list installed models'
      : 'Enter a model identifier');
  return (
    <label className={labelClass}>
      Model
      <input
        value={editor.model}
        onChange={(event) => editor.setModel(event.target.value)}
        className={inputClass}
        placeholder={placeholder}
        spellCheck={false}
        disabled={editor.operationPending}
        list={listId}
      />
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </label>
  );
}

/** The test result and the last save failure, in the order they happened. */
export function CredentialFeedback({ editor }: { editor: CredentialEditorState }) {
  return (
    <>
      {editor.testState.status === 'success' || editor.testState.status === 'error' ? (
        <SettingsFeedback kind={editor.testState.status}>
          {editor.testState.message}
        </SettingsFeedback>
      ) : null}
      {editor.saveFeedback ? (
        <SettingsFeedback kind={editor.saveFeedback.kind}>
          {editor.saveFeedback.message}
        </SettingsFeedback>
      ) : null}
    </>
  );
}

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">{children}</span>
  );
}
