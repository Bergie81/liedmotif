import { OPENROUTER_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { llmProviderMeta } from './llm-providers';

export interface ConfigurableProviderMeta {
  value: string;
  label: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  defaultModel?: string;
}

export interface MusicProviderMeta {
  value: 'suno';
  label: 'Suno-compatible';
  needsKey: true;
  needsBaseUrl: true;
}

export const MUSIC_PROVIDER: MusicProviderMeta = {
  value: 'suno',
  label: 'Suno-compatible',
  needsKey: true,
  needsBaseUrl: true,
};

/**
 * The generated-cover presets. The app stores their key and model; the other
 * `IMAGE_*` settings keep their adapter defaults unless `.env` sets them.
 */
export const IMAGE_PROVIDERS: readonly ConfigurableProviderMeta[] = [
  {
    value: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: OPENROUTER_DEFAULT_COVER_MODEL,
  },
];

/** A model set by an env variable, which outranks anything typed in the model field. */
export interface LockedModel {
  variable: string;
  model: string;
}

/** The cover-image model as a read-only field, when `IMAGE_MODEL` sets it. */
export function lockedImageModel(input: {
  modelEnvironmentManaged?: boolean;
  model?: string | null;
}): LockedModel | undefined {
  return input.modelEnvironmentManaged && input.model
    ? { variable: 'IMAGE_MODEL', model: input.model }
    : undefined;
}

/** The provider kinds onboarding and Settings → Providers can store a credential for. */
export type ConfigurableProviderType = 'music' | 'llm' | 'image';

export function isConfigurableProviderType(value: unknown): value is ConfigurableProviderType {
  return value === 'music' || value === 'llm' || value === 'image';
}

export function configurableProviderMeta(
  providerType: ConfigurableProviderType,
  providerKey: string,
): ConfigurableProviderMeta | undefined {
  switch (providerType) {
    case 'music':
      return providerKey === MUSIC_PROVIDER.value ? MUSIC_PROVIDER : undefined;
    case 'llm':
      return llmProviderMeta(providerKey);
    case 'image':
      return IMAGE_PROVIDERS.find((option) => option.value === providerKey);
  }
}

/**
 * How a resolved provider names itself in the UI, whichever layer configured it.
 * The preset matrix owns the label: a credential row stores whatever display name
 * the save supplied (the raw key, by default), so a stored name is only a
 * fallback for a provider key this build has no preset for.
 */
export function providerDisplayName(
  providerType: ConfigurableProviderType,
  providerKey: string,
  storedDisplayName?: string | null,
): string {
  return (
    configurableProviderMeta(providerType, providerKey)?.label ??
    (storedDisplayName?.trim() || providerKey)
  );
}
