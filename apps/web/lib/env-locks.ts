// Which provider fields `.env` sets, for the surfaces that lock them. The env
// layer the providers are built from (`readEnvLayer`) decides it, so a field is
// locked exactly when its env value is the one that runs. Only variable names
// and non-secret values leave the server; a key is named, never sent.

import { envFieldVariables, readEnvLayer, type CredentialProviderType } from '@liedmotif/db';
import type { EnvLocks } from '@/lib/configurable-providers';

export function readEnvLocks(providerType: CredentialProviderType, providerKey: string): EnvLocks {
  const fromEnv = readEnvLayer(providerType, providerKey);
  const variables = envFieldVariables(providerType);
  return {
    ...(fromEnv.apiKey && variables.apiKey ? { apiKey: { variable: variables.apiKey } } : {}),
    ...(fromEnv.baseUrl && variables.baseUrl
      ? { baseUrl: { variable: variables.baseUrl, value: fromEnv.baseUrl } }
      : {}),
    ...(fromEnv.model && variables.model
      ? { model: { variable: variables.model, value: fromEnv.model } }
      : {}),
  };
}

/** `readEnvLocks` for each provider a picker offers, leaving out those `.env` sets nothing for. */
export function readEnvLocksByProvider(
  providerType: CredentialProviderType,
  options: readonly { value: string }[],
): Record<string, EnvLocks> {
  const entries = options.map(({ value }) => [value, readEnvLocks(providerType, value)] as const);
  return Object.fromEntries(entries.filter(([, locks]) => Object.keys(locks).length > 0));
}
