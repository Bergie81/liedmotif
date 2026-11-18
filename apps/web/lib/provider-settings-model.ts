import type { CredentialSource, CredentialStatus } from '@liedmotif/db';
import { configurableProviderMeta, providerDisplayName } from '@/lib/configurable-providers';
import type { SettingsStatus } from '@/lib/settings-hub-model';

export function llmProviderPresentation(input: {
  selected: boolean;
  supported: boolean;
  configurationSource: 'environment' | 'database' | null;
  credentialSource: CredentialSource | null;
  decryptError: boolean;
  validationStatus: string | null;
  needsKey: boolean;
  needsBaseUrl: boolean;
  baseUrl?: string;
  model: string;
  defaultModel?: string;
}): { configured: boolean; source: 'Environment' | 'Database' | null; status: SettingsStatus } {
  if (!input.selected) {
    return {
      configured: false,
      source: null,
      status: { label: 'Unavailable', tone: 'muted' },
    };
  }
  const source =
    input.credentialSource === 'env'
      ? 'Environment'
      : input.credentialSource === 'database'
        ? 'Database'
        : input.configurationSource === 'environment'
          ? 'Environment'
          : input.configurationSource === 'database'
            ? 'Database'
            : null;
  const requirementsMet =
    input.supported &&
    (!input.needsKey || input.credentialSource !== null) &&
    (!input.needsBaseUrl || Boolean(input.baseUrl?.trim())) &&
    Boolean(input.model.trim() || input.defaultModel);
  const unhealthy =
    !requirementsMet ||
    input.decryptError ||
    (input.credentialSource === 'database' &&
      Boolean(input.validationStatus && input.validationStatus !== 'ok'));
  return {
    configured: !unhealthy,
    source,
    status: unhealthy
      ? { label: 'Unhealthy', tone: 'warn' }
      : source === 'Environment'
        ? { label: 'Environment', tone: 'ok' }
        : { label: 'Configured', tone: 'ok' },
  };
}

/**
 * The cover-image provider as the UI reports it. Generated covers are optional,
 * so a provider with no key anywhere reads as not configured rather than
 * unhealthy when only `IMAGE_PROVIDER` names it; one saved in the app without a
 * key resolving (its shared Text AI key went away) needs a key.
 */
export function generatedImageProviderPresentation(input: {
  /** The selected provider's credential status, or `null` when none is selected. */
  credential: CredentialStatus | null;
  /** The model covers render with: `IMAGE_MODEL`, else the saved one, else the preset default. */
  model: string | null;
}): {
  name: string;
  configured: boolean;
  source: string | null;
  model: string | null;
  status: SettingsStatus;
} {
  const { credential, model } = input;
  const name = credential
    ? providerDisplayName('image', credential.providerKey, credential.displayName)
    : 'Not configured';
  if (!credential?.configured) {
    // A stored row always carries a display name; an env-only selection has none.
    const saved = credential?.displayName != null;
    return saved
      ? {
          name,
          configured: false,
          source: null,
          model,
          status: { label: 'Needs a key', tone: 'warn' },
        }
      : {
          name: 'Not configured',
          configured: false,
          source: null,
          model,
          status: { label: 'Unavailable', tone: 'muted' },
        };
  }
  const source =
    credential.source === 'env'
      ? 'Environment'
      : credential.source === 'shared'
        ? `Shared ${name} key`
        : 'Database';
  const configured =
    configurableProviderMeta('image', credential.providerKey) !== undefined &&
    !credential.decryptError;
  return {
    name,
    configured,
    source,
    model,
    status: !configured
      ? { label: 'Unhealthy', tone: 'warn' }
      : source === 'Environment'
        ? { label: 'Environment', tone: 'ok' }
        : { label: 'Configured', tone: 'ok' },
  };
}

export function requiresProviderReplacementConfirmation(input: {
  configured: boolean;
  initialProviderKey: string;
  nextProviderKey: string;
}): boolean {
  return input.configured && input.initialProviderKey !== input.nextProviderKey;
}

const ACCOUNT_NOT_READY_CAUSES: Readonly<Record<string, string>> = {
  gemini: 'Google needs billing turned on for image models.',
  openai: 'OpenAI needs your organisation verified for image models.',
};

/**
 * The Cover images card's account alert: the cause, while the Instance's
 * newest Cover outcome is an image account the vendor refused and no
 * credential that supplies the Cover key has been saved since. A save is the
 * Admin saying they fixed it; the next Cover tells whether they did.
 */
export function coverAccountAlert(input: {
  outcome: { providerKey: string; accountNotReady: boolean; settledAt: Date } | null;
  /** When each credential supplying the Cover key was last saved; `null` when none is stored. */
  credentialsSavedAt: readonly (Date | null)[];
}): string | null {
  const { outcome } = input;
  if (!outcome?.accountNotReady) return null;
  const savedSince = input.credentialsSavedAt.some(
    (savedAt) => savedAt !== null && savedAt > outcome.settledAt,
  );
  return savedSince ? null : (ACCOUNT_NOT_READY_CAUSES[outcome.providerKey] ?? null);
}

export const COVER_KEY_NOTICE =
  'Cover images use this key too. Changing the provider or removing this key turns Tailored Cover Art off until Cover images has its own key.';

/**
 * The Text AI card's warning, while Cover images use its key: a change to the
 * Text AI then takes the Cover key away. A Cover provider with its own key is
 * untouched by the Text AI, so it gets no warning.
 */
export function coverKeyNotice(
  coverCredential: Pick<CredentialStatus, 'source'> | null,
): string | null {
  return coverCredential?.source === 'shared' ? COVER_KEY_NOTICE : null;
}
