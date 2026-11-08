// Credential security surface: AES-256-GCM envelope crypto, secret
// masking, the env-first resolution rule, and the provider-credential repository.

export {
  CRYPTO_VERSION,
  ENCRYPTION_KEY_ENV,
  DecryptionError,
  EncryptionKeyError,
  decodeEncryptionKey,
  loadEncryptionKey,
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
} from './crypto';

export { maskSecret } from './masking';

export {
  readEnvLayer,
  resolveCredentialSource,
  resolveLlmRuntimeSettings,
  resolveProviderSettings,
  selectProviderKey,
  type CredentialSource,
  type CredentialProviderType,
  type ImageRuntimeSettings,
  type LlmRuntimeSettings,
  type MusicRuntimeSettings,
} from './resolution';

export {
  upsertProviderCredential,
  deleteProviderCredential,
  setCredentialValidation,
  getCredentialStatus,
  listCredentialStatuses,
  getCredentialUpdatedAt,
  getStoredProviderConfig,
  getStoredProviderKey,
  resolveProviderCredential,
  resolveImageRuntimeConfig,
  resolveLlmRuntimeConfig,
  resolveMusicRuntimeConfig,
  type CredentialRef,
  type CredentialStatus,
  type ResolvedCredential,
  type UpsertCredentialInput,
} from './repo';
