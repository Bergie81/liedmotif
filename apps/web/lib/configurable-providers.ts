import {
  DEFAULT_UNIT_COSTS,
  GEMINI_DEFAULT_COVER_MODEL,
  OPENAI_DEFAULT_COVER_MODEL,
  OPENROUTER_DEFAULT_COVER_MODEL,
} from '@liedmotif/shared';
import { llmProviderMeta } from './llm-providers';

export interface ConfigurableProviderMeta {
  value: string;
  label: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  defaultModel?: string;
  /** The provider picker lists this preset only once More options is opened. */
  behindMoreOptions?: boolean;
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

export interface ImageProviderMeta extends ConfigurableProviderMeta {
  /**
   * What one Cover costs on the default model at the app's `high` quality, list
   * price rounded up to the cent. The source of every Cover price the app states.
   */
  coverPriceUsd: number;
}

/**
 * The generated-cover presets, in picker order. The app stores their key and
 * model; the other `IMAGE_*` settings keep their adapter defaults unless `.env`
 * sets them.
 */
export const IMAGE_PROVIDERS: readonly ImageProviderMeta[] = [
  {
    value: 'openai',
    label: 'OpenAI',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: OPENAI_DEFAULT_COVER_MODEL,
    coverPriceUsd: 0.06,
  },
  {
    value: 'gemini',
    label: 'Gemini',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: GEMINI_DEFAULT_COVER_MODEL,
    coverPriceUsd: 0.04,
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: OPENROUTER_DEFAULT_COVER_MODEL,
    coverPriceUsd: 0.07,
    behindMoreOptions: true,
  },
];

/**
 * About what one Cover costs on an image preset. A provider key this build has
 * no preset for falls back to the shipped default price.
 */
export function coverPriceUsd(providerKey: string): number {
  return (
    IMAGE_PROVIDERS.find((option) => option.value === providerKey)?.coverPriceUsd ??
    DEFAULT_UNIT_COSTS.perCoverUsd
  );
}

/** The same price in whole cents, the unit the UI states it in. */
export function coverPriceCents(providerKey: string): number {
  return Math.round(coverPriceUsd(providerKey) * 100);
}

/**
 * The Instance's price per Cover once `providerKey` is saved as the Cover
 * provider: a price that is some preset's list price follows the new preset;
 * any other price (zero included) is the Admin's own and stays.
 */
export function followedCoverUnitCost(currentUsd: number, providerKey: string): number {
  const listPrice = IMAGE_PROVIDERS.some((option) => option.coverPriceUsd === currentUsd);
  return listPrice ? coverPriceUsd(providerKey) : currentUsd;
}

export interface ProviderPicker<T> {
  /** The presets the picker lists, main ones first, each group in preset order. */
  shown: readonly T[];
  /** Some presets wait behind a More options button. */
  moreOptionsHidden: boolean;
}

/**
 * Which presets a provider picker lists. The selected preset and the one the
 * editor loaded (the stored one) are always among them, so an Instance already
 * on an advanced provider opens with More options expanded, looks set up rather
 * than empty, and keeps its provider in view while the Admin compares others.
 */
export function providerPicker<T extends { value: string; behindMoreOptions?: boolean }>(
  options: readonly T[],
  {
    selectedKey,
    loadedKey,
    moreOptionsOpened,
  }: { selectedKey: string; loadedKey: string; moreOptionsOpened: boolean },
): ProviderPicker<T> {
  const main = options.filter((option) => !option.behindMoreOptions);
  const more = options.filter((option) => option.behindMoreOptions);
  const open =
    moreOptionsOpened ||
    more.some((option) => option.value === selectedKey || option.value === loadedKey);
  return {
    shown: open ? [...main, ...more] : main,
    moreOptionsHidden: !open && more.length > 0,
  };
}

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
