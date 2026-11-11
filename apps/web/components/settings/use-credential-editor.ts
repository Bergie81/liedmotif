'use client';

import { useRef, useState } from 'react';
import type { ConfigurableProviderType } from '@/lib/configurable-providers';
import { llmEffectiveModel, llmModelMissing } from '@/lib/llm-providers';
import { requiresProviderReplacementConfirmation } from '@/lib/provider-settings-model';
import {
  beginCredentialTest,
  isCredentialTestResultCurrent,
  listedModels,
  resolveCredentialTest,
  type CredentialTestBody,
  type CredentialTestState,
} from './credential-test-state';
import { useCredentialMutationGate } from './credential-mutation-group';

export interface ProviderOption {
  value: string;
  label: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  defaultModel?: string;
  listsModels?: boolean;
  baseUrlPlaceholder?: string;
}

export interface CredentialEditorProps {
  providerType: ConfigurableProviderType;
  options: readonly ProviderOption[];
  initialProviderKey: string;
  currentMasked: string | null;
  configured: boolean;
  hasExistingSelection?: boolean;
  databaseWritesEnabled: boolean;
  showModel?: boolean;
  initialBaseUrl?: string;
  initialModel?: string;
  /**
   * What a successful save means for the surrounding surface, given what was stored.
   * Required, because "saved" has no useful default: Settings reloads to re-resolve
   * the server-rendered credential status, while a wizard advances instead — a reload
   * would drop the step it is on.
   */
  onSaved: (saved: { providerKey: string; model: string | null }) => void;
}

type SaveFeedback = { kind: 'success' | 'error'; message: string } | null;

export function useCredentialEditor(props: CredentialEditorProps) {
  const initialSelection = props.options.some((option) => option.value === props.initialProviderKey)
    ? props.initialProviderKey
    : (props.options[0]?.value ?? '');
  const [providerKey, setProviderKey] = useState(initialSelection);
  const providerKeyRef = useRef(providerKey);
  const testRequestId = useRef(0);
  const [secret, setSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(props.initialBaseUrl ?? '');
  const [model, setModel] = useState(props.initialModel ?? '');
  // Held apart from the test state, which every model edit resets: picking a
  // suggestion must not take the suggestions away.
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [testState, setTestState] = useState<CredentialTestState>({ status: 'idle' });
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(null);
  const gate = useCredentialMutationGate();
  const selected = props.options.find((option) => option.value === providerKey) ?? props.options[0];
  const operationPending = gate.pending !== null;
  const canTest = Boolean(secret.trim() || baseUrl.trim() || model.trim()) || props.configured;

  /**
   * Editing any field invalidates the last test result: a "Connection verified"
   * left standing beside a since-edited key would be a claim about a credential
   * nothing ever checked. Bumping the request id also drops an in-flight result.
   */
  function invalidateTest() {
    testRequestId.current += 1;
    setTestState({ status: 'idle' });
  }

  /**
   * A blank field is omitted (the stored config is kept), except where it was
   * showing the saved provider's base URL: an explicit empty value tells the
   * server to drop that stored endpoint so the provider default applies.
   */
  function submittedBaseUrl(): string | undefined {
    if (baseUrl.trim()) return baseUrl;
    const clearedSaved =
      providerKey === props.initialProviderKey && Boolean(props.initialBaseUrl?.trim());
    return clearedSaved ? '' : undefined;
  }

  /**
   * A field still showing its loaded value is left out of a save, so the stored
   * config keeps whatever it had: that value is the effective one, which may come
   * from `.env` or be the preset's default, and storing it would let it outrank
   * the provider default once the env line is removed or the default moves.
   */
  function savedFields(): { baseUrl: string | undefined; model: string | undefined } {
    const onLoadedProvider = providerKey === props.initialProviderKey;
    const baseUrlUnchanged = onLoadedProvider && baseUrl === (props.initialBaseUrl ?? '');
    const modelUnchanged = onLoadedProvider && model === (props.initialModel ?? '');
    return {
      baseUrl: baseUrlUnchanged ? undefined : submittedBaseUrl(),
      model: modelUnchanged ? undefined : model || undefined,
    };
  }

  function editSecret(value: string) {
    setSecret(value);
    invalidateTest();
  }

  function editBaseUrl(value: string) {
    setBaseUrl(value);
    setDiscoveredModels([]);
    invalidateTest();
  }

  function editModel(value: string) {
    setModel(value);
    invalidateTest();
  }

  function selectProvider(value: string) {
    if (operationPending) return;
    testRequestId.current += 1;
    providerKeyRef.current = value;
    setProviderKey(value);
    const isSaved = value === props.initialProviderKey;
    setModel(isSaved ? (props.initialModel ?? '') : '');
    setBaseUrl(isSaved ? (props.initialBaseUrl ?? '') : '');
    setDiscoveredModels([]);
    setTestState({ status: 'idle' });
    setSaveFeedback(null);
  }

  async function test() {
    if (!selected || operationPending) return;
    if (props.providerType === 'llm' && !selected.listsModels && llmModelMissing(selected, model)) {
      setTestState({ status: 'error', message: 'Enter the model for this provider first.' });
      return;
    }
    if (!gate.begin('test')) return;
    try {
      setTestState(beginCredentialTest());
      setSaveFeedback(null);
      const requestId = ++testRequestId.current;
      const testedProviderKey = providerKey;
      const response = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: props.providerType,
          providerKey,
          secret: secret || undefined,
          baseUrl: submittedBaseUrl(),
          model: model || undefined,
        }),
      }).catch(() => null);
      const current = isCredentialTestResultCurrent({
        requestId,
        currentRequestId: testRequestId.current,
        testedProviderKey,
        currentProviderKey: providerKeyRef.current,
      });
      if (current && !response) setTestState(resolveCredentialTest(null));
      if (current && response) {
        const body = (await response.json().catch(() => ({}))) as CredentialTestBody;
        setTestState(resolveCredentialTest({ status: response.status, body }));
        setDiscoveredModels(listedModels(body));
      }
    } finally {
      gate.end('test');
    }
  }

  async function save() {
    if (!props.databaseWritesEnabled || operationPending || !gate.begin('save')) return;
    let response: Response | null;
    let body: { ok?: boolean; error?: string | { message?: string } };
    try {
      testRequestId.current += 1;
      const replacing = requiresProviderReplacementConfirmation({
        configured: props.hasExistingSelection ?? props.configured,
        initialProviderKey: props.initialProviderKey,
        nextProviderKey: providerKey,
      });
      if (
        replacing &&
        !window.confirm('Replace the currently configured provider with this selection?')
      ) {
        return;
      }

      setTestState({ status: 'idle' });
      setSaveFeedback(null);
      response = await fetch('/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerType: props.providerType,
          providerKey,
          secret: secret || undefined,
          ...savedFields(),
        }),
      }).catch(() => null);
      body = response ? ((await response.json().catch(() => ({}))) as typeof body) : {};
    } finally {
      gate.end('save');
    }
    if (response?.ok && body.ok) {
      props.onSaved({ providerKey, model: llmEffectiveModel(selected, model) });
      return;
    }
    const message = typeof body.error === 'string' ? body.error : body.error?.message;
    setSaveFeedback({ kind: 'error', message: message ?? 'Could not save.' });
  }

  return {
    providerKey,
    selected,
    secret,
    setSecret: editSecret,
    baseUrl,
    setBaseUrl: editBaseUrl,
    model,
    setModel: editModel,
    discoveredModels,
    testState,
    saveFeedback,
    operationPending,
    testing: gate.pending === 'test',
    saving: gate.pending === 'save',
    canTest,
    selectProvider,
    test,
    save,
  };
}

/** The live editor a credential surface renders against. */
export type CredentialEditorState = ReturnType<typeof useCredentialEditor>;
