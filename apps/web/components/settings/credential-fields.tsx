// The controls a provider credential is edited with, shared by Settings →
// Providers and the first-login onboarding steps. Both surfaces arrange them
// differently, but neither gets to word them differently.

'use client';

import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { providerPicker, type LockedModel } from '@/lib/configurable-providers';
import { segmentedListClass, segmentedTriggerClass } from '@/components/ui/design-system';
import { inputClass, labelClass } from '@/components/ui/form-styles';
import type { CredentialEditorState, ProviderOption } from './use-credential-editor';

export function ProviderChoice({
  editor,
  options,
}: {
  editor: CredentialEditorState;
  options: readonly ProviderOption[];
}) {
  const [moreOptionsOpened, setMoreOptionsOpened] = useState(false);
  if (options.length <= 1) return null;
  const picker = providerPicker(options, {
    selectedKey: editor.providerKey,
    loadedKey: editor.loadedProviderKey,
    moreOptionsOpened,
  });
  return (
    <div className={labelClass}>
      <span>Provider</span>
      <div className={cn(segmentedListClass, 'overflow-x-auto')} role="group">
        {picker.shown.map((option) => (
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
      {picker.moreOptionsHidden ? (
        <button
          type="button"
          onClick={() => setMoreOptionsOpened(true)}
          className="self-start text-[13px] font-semibold text-muted [-webkit-tap-highlight-color:transparent] hover:text-paper"
        >
          More options
        </button>
      ) : null}
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
  const vendor = editor.selected.label;
  if (editor.usesSharedKey) {
    return (
      <div className={labelClass}>
        {label}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] font-normal text-muted">
          <span>Uses your {vendor} key</span>
          <KeyAction editor={editor} onClick={() => editor.shareKey(false)}>
            Use a separate key
          </KeyAction>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
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
      {editor.canShareKey ? (
        <KeyAction editor={editor} onClick={() => editor.shareKey(true)}>
          Use the same {vendor} key
        </KeyAction>
      ) : null}
    </div>
  );
}

function KeyAction({
  editor,
  onClick,
  children,
}: {
  editor: CredentialEditorState;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={editor.operationPending}
      className="self-start text-[13px] font-semibold text-muted [-webkit-tap-highlight-color:transparent] hover:text-paper"
    >
      {children}
    </button>
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

function FieldNote({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">{children}</span>
  );
}
