import {
  getCredentialUpdatedAt,
  getLatestCoverAccountOutcome,
  readEnvLayer,
  resolveLlmRuntimeSettings,
  resolveProviderSettings,
  resolveShareableTextLlmKey,
  type CredentialRef,
} from '@liedmotif/db';
import {
  configurableProviderMeta,
  IMAGE_PROVIDERS,
  providerDisplayName,
} from '@/lib/configurable-providers';
import { encryptionKeyIfConfigured, getProviderStatuses } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { llmEffectiveModel, llmProviderMeta } from '@/lib/llm-providers';
import {
  coverAccountAlert,
  coverKeyNotice,
  generatedImageProviderPresentation,
  llmProviderPresentation,
} from '@/lib/provider-settings-model';
import { credentialState } from '@/lib/settings-hub-model';

/**
 * The account alert for the Cover images card's provider. The credentials that
 * supply the Cover key are the ones whose save clears it.
 */
export async function loadCoverAccountAlert(
  coverProviderKey: string,
  coverKeyCredentials: readonly CredentialRef[],
) {
  const db = getDb();
  const [outcome, credentialsSavedAt] = await Promise.all([
    getLatestCoverAccountOutcome(db, coverProviderKey),
    Promise.all(coverKeyCredentials.map((ref) => getCredentialUpdatedAt(db, ref))),
  ]);
  return coverAccountAlert({ outcome, credentialsSavedAt });
}

/**
 * The image provider that can use the Text AI's key, or `null`. Only the vendor
 * leaves the server; an unreadable key shares nothing.
 */
export async function loadSharedKeyVendor(): Promise<string | null> {
  try {
    const shared = await resolveShareableTextLlmKey(getDb(), {
      encryptionKey: encryptionKeyIfConfigured(),
    });
    return shared?.vendor ?? null;
  } catch {
    return null;
  }
}

export async function loadProviderSettingsData() {
  const [statuses, sharedKeyVendor] = await Promise.all([
    getProviderStatuses(),
    loadSharedKeyVendor(),
  ]);
  const musicBaseUrl = resolveProviderSettings(
    'music',
    statuses.music.providerKey,
    statuses.music.config,
  ).baseUrl;
  const llmKey = statuses.llm?.providerKey ?? 'openai';
  const llmSettings = statuses.llm
    ? resolveLlmRuntimeSettings({ providerKey: llmKey, storedConfig: statuses.llm.config })
    : null;
  const llmMeta = llmProviderMeta(llmKey);
  const imageKey = statuses.image?.providerKey ?? IMAGE_PROVIDERS[0]!.value;
  const imageMeta = configurableProviderMeta('image', imageKey);
  const llmPresentation = llmProviderPresentation({
    selected: statuses.llm !== null,
    supported: Boolean(llmMeta),
    configurationSource: statuses.llmConfigurationSource,
    credentialSource: statuses.llm?.source ?? null,
    decryptError: statuses.llm?.decryptError ?? false,
    validationStatus: statuses.llm?.validationStatus ?? null,
    needsKey: llmMeta?.needsKey ?? true,
    needsBaseUrl: llmMeta?.needsBaseUrl ?? false,
    baseUrl: llmSettings?.baseUrl,
    model: llmSettings?.model ?? '',
    defaultModel: llmMeta?.defaultModel,
  });

  return {
    encryptionKeyConfigured: statuses.encryptionKeyConfigured,
    storedLlmProviderKey: statuses.storedLlmProviderKey,
    llmConfigurationSource: statuses.llmConfigurationSource,
    music: {
      credential: statuses.music,
      displayName: providerDisplayName(
        'music',
        statuses.music.providerKey,
        statuses.music.displayName,
      ),
      baseUrl: musicBaseUrl,
      status: credentialState(statuses.music),
      source:
        statuses.music.source === 'env'
          ? ('Environment' as const)
          : statuses.music.source === 'database'
            ? ('Database' as const)
            : null,
    },
    llm: {
      credential: statuses.llm,
      providerKey: llmKey,
      displayName: providerDisplayName('llm', llmKey, statuses.llm?.displayName),
      settings: llmSettings,
      effectiveModel: llmEffectiveModel(llmMeta, llmSettings?.model),
      presentation: llmPresentation,
      coverKeyNotice: coverKeyNotice(statuses.image),
    },
    cover: {
      credential: statuses.image,
      providerKey: imageKey,
      modelEnvironmentManaged: readEnvLayer('image', imageKey).model !== undefined,
      sharedKeyVendor,
      sharesKey: statuses.image?.source === 'shared',
      ...generatedImageProviderPresentation({
        credential: statuses.image,
        model:
          resolveProviderSettings('image', imageKey, statuses.image?.config).model ??
          imageMeta?.defaultModel ??
          null,
      }),
    },
  };
}
