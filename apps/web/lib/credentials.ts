// Server-side credential helpers for the setup wizard and settings pages.
//
// These resolve UI-facing status (configured?, env vs database, masked preview)
// for the providers the instance cares about: the required music provider (Suno),
// the optional text LLM and the optional cover-image provider. The raw secret is
// never returned to the UI.

import {
  getStoredProviderKey,
  listCredentialStatuses,
  selectProviderKey,
  type CredentialRef,
  type CredentialStatus,
} from '@liedmotif/db';
import { getDb } from '@/lib/db';
import { getEncryptionKey } from './env';

/** The one hard-required provider (the music model). */
export const MUSIC_REF: CredentialRef = { providerType: 'music', providerKey: 'suno' };

/**
 * Load the encryption key when one is configured. An ABSENT key is fine (env-only
 * instance → `undefined`); a PRESENT-but-invalid key throws (fail fast).
 */
export function encryptionKeyIfConfigured(): Buffer | undefined {
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) return undefined;
  return getEncryptionKey();
}

export interface ProviderStatuses {
  music: CredentialStatus;
  llm: CredentialStatus | null;
  llmConfigurationSource: 'environment' | 'database' | null;
  storedLlmProviderKey: string | null;
  /** The cover-image provider `IMAGE_PROVIDER` or a saved key selects; `null` when neither does. */
  image: CredentialStatus | null;
  /** Whether DB-stored secrets are possible (the AES key is configured). */
  encryptionKeyConfigured: boolean;
}

/** Resolve the music + optional LLM and cover-image credential statuses for the UI. */
export async function getProviderStatuses(): Promise<ProviderStatuses> {
  const encryptionKey = encryptionKeyIfConfigured();
  const [storedLlmProviderKey, storedImageProviderKey] = await Promise.all([
    getStoredProviderKey(getDb(), 'llm'),
    getStoredProviderKey(getDb(), 'image'),
  ]);
  const llmKey = selectProviderKey('llm', process.env, storedLlmProviderKey);
  const imageKey = selectProviderKey('image', process.env, storedImageProviderKey);
  const refs: CredentialRef[] = [
    MUSIC_REF,
    ...(llmKey ? [{ providerType: 'llm' as const, providerKey: llmKey }] : []),
    ...(imageKey ? [{ providerType: 'image' as const, providerKey: imageKey }] : []),
  ];
  const statuses = await listCredentialStatuses(getDb(), refs, { encryptionKey });
  const statusOf = (type: CredentialRef['providerType']) =>
    statuses.find((status) => status.providerType === type) ?? null;
  return {
    music: statusOf('music')!,
    llm: statusOf('llm'),
    image: statusOf('image'),
    llmConfigurationSource: llmKey
      ? process.env.LLM_PROVIDER?.trim()
        ? 'environment'
        : 'database'
      : null,
    storedLlmProviderKey,
    encryptionKeyConfigured: encryptionKey !== undefined,
  };
}
