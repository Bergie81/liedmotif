// Shared provider primitives. Every vendor-facing capability (music, LLM, image)
// is reached through one of these interfaces so app/business logic never imports
// a vendor SDK directly. Concrete adapters (Suno, OpenAI-compatible, OpenRouter,
// Ollama, local FS) live behind them.
//
// Shared principles every adapter follows:
//   - Return NORMALIZED results plus provider metadata; vendor-specific raw data
//     lives only in REDACTED diagnostics (see `diagnostics.ts`).
//   - Never import React or any `next/*` module — provider code is pure TS usable
//     by both web API routes and worker jobs.
//   - Expose capabilities so callers branch on capability, never on vendor name.

import type { ProviderDiagnostics } from '@liedmotif/shared';

export type { ProviderDiagnostics, RedactedJson } from '@liedmotif/shared';

export type ProviderType = 'music' | 'llm' | 'image' | 'storage';

/** Result of a server-side credential validation check. Never includes secrets. */
export interface ProviderValidationResult {
  ok: boolean;
  /** Safe, user-presentable message — never raw provider errors or secrets. */
  message?: string;
  /** Optional remaining provider credit/units, when the provider exposes it (non-secret). */
  balance?: number;
}

/** The minimum every provider adapter exposes. */
export interface BaseProvider {
  readonly providerType: ProviderType;
  /** Stable adapter key, e.g. `suno`, `openrouter`, `ollama`. */
  readonly providerKey: string;
  validateCredentials(): Promise<ProviderValidationResult>;
}

/**
 * Non-secret descriptor of which adapter produced a result. Safe to persist and
 * surface in diagnostics/telemetry — it carries no credentials.
 */
export interface ProviderMetadata {
  providerType: ProviderType;
  providerKey: string;
  /** Model / preset identifier where applicable (e.g. `V5`, `gpt-4o-mini`). */
  model?: string;
}

/**
 * A normalized provider outcome: the typed, vendor-neutral result plus who
 * produced it and (optionally) the redacted diagnostics behind it.
 */
export interface NormalizedProviderResult<T> {
  result: T;
  provider: ProviderMetadata;
  diagnostics?: ProviderDiagnostics;
}
