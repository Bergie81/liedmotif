// Provider credential validation — server-side only, sanitized results.
//
// A credential is validated with lightweight, read-only calls to the provider —
// Suno's credit endpoint; for a text LLM or cover-image key, a key check and then,
// when a model is given, a lookup of that model — never a paid generation. All
// vendor specifics — endpoints, status mapping — live INSIDE this adapter so app
// and business logic never hardcode Suno. Results are always
// sanitized: a fixed, actionable reason code and a safe message, NEVER the raw
// provider error body or the secret. This is intentionally minimal; the full
// provider/generation layer lives in the adapters.

import type { ProviderType, ProviderValidationResult } from '../types';

/** Sanitized, actionable outcome of a validation check. */
export type ValidationReason =
  | 'ok'
  | 'unauthorized'
  | 'unreachable'
  | 'unexpected_status'
  | 'misconfigured'
  | 'unknown_model'
  /** The key works, but the endpoint offers no model list to check the model against. */
  | 'model_unchecked';

const PASSING_REASONS: ReadonlySet<ValidationReason> = new Set(['ok', 'model_unchecked']);

export interface CredentialValidationInput {
  providerType: ProviderType;
  providerKey: string;
  /** Bearer secret for the provider (Suno, OpenRouter, OpenAI-compatible). */
  secret?: string;
  /** Base URL for providers whose endpoint isn't fixed (LLM presets, Suno override). */
  baseUrl?: string;
  /** The model to check once the key passes (text LLM or cover image). */
  model?: string;
  /**
   * The transport for the probe, defaulting to the global `fetch`. The caller
   * owns it: a caller probing an admin-configured base URL passes an
   * address-pinning fetch, as the LLM adapter does.
   */
  fetchImpl?: typeof fetch;
  /** Network timeout in ms. Defaults to 8s. */
  timeoutMs?: number;
}

export interface CredentialValidationResult extends ProviderValidationResult {
  reason: ValidationReason;
  /** Optional non-secret detail (e.g. remaining provider credits). */
  detail?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const SUNO_DEFAULT_BASE_URL = 'https://api.sunoapi.org';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/** Fixed, safe messages per reason — never built from a provider response. */
const MESSAGES: Record<ValidationReason, string> = {
  ok: 'Credentials verified.',
  unauthorized: 'The provider rejected these credentials. Check the API key.',
  unreachable: 'Could not reach the provider. Check the base URL and network.',
  unexpected_status: 'The provider returned an unexpected response. Check the configuration.',
  misconfigured: 'Missing or unsupported configuration for this provider.',
  unknown_model: 'The provider does not offer this model. Check the model ID.',
  model_unchecked: 'Key verified. This endpoint lists no models, so the model ID is unchecked.',
};

function result(
  reason: ValidationReason,
  detail?: Record<string, unknown>,
): CredentialValidationResult {
  return {
    ok: PASSING_REASONS.has(reason),
    reason,
    message: MESSAGES[reason],
    ...(detail ? { detail } : {}),
  };
}

/** Strip a trailing slash so base-URL joins don't double up. */
function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Make one read-only GET and map the HTTP status to a sanitized reason. Any thrown
 * error (DNS, refused, timeout, abort) becomes `unreachable` — the underlying
 * error is never surfaced, so a provider message or the key can't leak.
 *
 * Redirects are NOT followed (`redirect: 'manual'`): an initially-public URL could
 * otherwise 302 to a private/metadata host, defeating the SSRF guard. A redirect
 * surfaces as a non-2xx status and is treated as unexpected.
 */
async function probe(
  url: string,
  options: { secret?: string; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<{ status: number; body: unknown } | { error: true }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.secret) headers.authorization = `Bearer ${options.secret}`;
    const response = await options.fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    let body: unknown = undefined;
    try {
      body = await response.json();
    } catch {
      // A non-JSON body is fine; status alone drives the decision.
    }
    return { status: response.status, body };
  } catch {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Map an HTTP status to a reason, optionally extracting a non-secret detail on 200. */
function fromStatus(
  status: number,
  onOk?: (body: unknown) => Record<string, unknown> | undefined,
  body?: unknown,
): CredentialValidationResult {
  if (status >= 200 && status < 300) return result('ok', onOk?.(body));
  if (status === 401 || status === 403) return result('unauthorized');
  // 3xx (redirects are not followed) and everything else are unexpected.
  return result('unexpected_status');
}

const MAX_LISTED_MODELS = 200;
const MAX_MODEL_NAME_LENGTH = 200;

/** The installed model names from Ollama's `/api/tags` reply, for the model picker. */
function ollamaModels(body: unknown): Record<string, unknown> {
  const entries = (body as { models?: unknown } | undefined)?.models;
  const models = (Array.isArray(entries) ? entries : [])
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= MAX_MODEL_NAME_LENGTH)
    .slice(0, MAX_LISTED_MODELS);
  return { models };
}

/**
 * Validate a provider credential with a single sanitized, read-only check.
 * Dispatches to the per-provider probe; unsupported providers report
 * `misconfigured` rather than reaching the network.
 */
export async function validateCredential(
  input: CredentialValidationInput,
): Promise<CredentialValidationResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secret = input.secret?.trim() || undefined;

  if (input.providerType === 'music' && input.providerKey === 'suno') {
    if (!secret) return result('misconfigured');
    const base = trimBaseUrl(input.baseUrl?.trim() || SUNO_DEFAULT_BASE_URL);
    const res = await probe(`${base}/api/v1/generate/credit`, { secret, fetchImpl, timeoutMs });
    if ('error' in res) return result('unreachable');
    if (res.status < 200 || res.status >= 300) return fromStatus(res.status);
    // Suno also refuses under HTTP 200, so only the envelope the adapter itself
    // accepts (code 200 with a numeric balance) verifies the credential.
    const code = (res.body as { code?: unknown } | undefined)?.code;
    if (code === 401 || code === 403) return result('unauthorized');
    const credits = code === 200 ? extractSunoCredits(res.body) : undefined;
    return credits ? result('ok', credits) : result('unexpected_status');
  }

  if (input.providerType === 'llm') {
    return validateLlm(input, { fetchImpl, timeoutMs, secret });
  }

  if (input.providerType === 'image' && input.providerKey === 'openrouter') {
    if (!secret) return result('misconfigured');
    return validateOpenRouter(
      input.model?.trim() || undefined,
      (path) => `images/models/${path}/endpoints`,
      { base: OPENROUTER_DEFAULT_BASE_URL, secret, fetchImpl, timeoutMs },
    );
  }

  // Storage has no remote probe, so it lands here with every unsupported provider.
  return result('misconfigured');
}

/**
 * An OpenRouter key, then the model it is meant to run. OpenRouter's model
 * listings answer any key, so the key's own metadata endpoint is the one free
 * read that refuses a wrong one. The model is read from a free per-model route
 * that answers 404 for a model OpenRouter has no entry for: the cover image reads
 * the Images API endpoints listing the cover adapter's capability discovery
 * reads, the text LLM its catalog entry.
 */
async function validateOpenRouter(
  model: string | undefined,
  modelRoute: (encodedModelPath: string) => string,
  ctx: { base: string; secret: string; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<CredentialValidationResult> {
  const keyRes = await probe(`${ctx.base}/key`, ctx);
  if ('error' in keyRes) return result('unreachable');
  const keyResult = fromStatus(keyRes.status);
  if (!keyResult.ok || !model) return keyResult;
  const segments = model.split('/');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    return result('unknown_model');
  }
  const res = await probe(
    `${ctx.base}/${modelRoute(segments.map(encodeURIComponent).join('/'))}`,
    ctx,
  );
  if ('error' in res) return result('unreachable');
  if (res.status === 404) return result('unknown_model');
  return fromStatus(res.status);
}

/** The model IDs an OpenAI-style `/models` reply lists, or `null` when it lists none. */
function listedModelIds(body: unknown): Set<string> | null {
  const entries = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(entries)) return null;
  const ids = entries
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
  return new Set(ids);
}

/**
 * Text LLM: the key first, then — when a model is given — the model, each failure
 * with its own reason. A call without a model (the adapter's own check) verifies
 * the key alone.
 */
async function validateLlm(
  input: CredentialValidationInput,
  ctx: { fetchImpl: typeof fetch; timeoutMs: number; secret?: string },
): Promise<CredentialValidationResult> {
  const model = input.model?.trim() || undefined;

  switch (input.providerKey) {
    case 'ollama': {
      const base = trimBaseUrl(input.baseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL);
      const res = await probe(`${base}/api/tags`, {
        fetchImpl: ctx.fetchImpl,
        timeoutMs: ctx.timeoutMs,
      });
      if ('error' in res) return result('unreachable');
      const checked = fromStatus(res.status, ollamaModels, res.body);
      if (!checked.ok || !model) return checked;
      // Ollama resolves an untagged name to its `:latest` tag. A missing model
      // keeps the installed list, so the picker can offer the right one.
      const installed = (checked.detail?.models ?? []) as string[];
      const pulled = installed.includes(model) || installed.includes(`${model}:latest`);
      return pulled ? checked : result('unknown_model', checked.detail);
    }
    case 'openai': {
      if (!ctx.secret) return result('misconfigured');
      const base = trimBaseUrl(input.baseUrl?.trim() || OPENAI_DEFAULT_BASE_URL);
      // Retrieving one model authenticates the key too: 401 for the key, 404 for the model.
      const url = model ? `${base}/models/${encodeURIComponent(model)}` : `${base}/models`;
      const res = await probe(url, ctx);
      if ('error' in res) return result('unreachable');
      if (model && res.status === 404) return result('unknown_model');
      return fromStatus(res.status);
    }
    case 'openrouter': {
      if (!ctx.secret) return result('misconfigured');
      return validateOpenRouter(model, (path) => `model/${path}`, {
        ...ctx,
        base: trimBaseUrl(input.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL),
        secret: ctx.secret,
      });
    }
    case 'openai-compatible': {
      const base = input.baseUrl?.trim();
      if (!base) return result('misconfigured'); // generic preset needs an explicit base URL
      if (!ctx.secret) return result('misconfigured'); // ...and an API key (matches OpenRouter)
      const res = await probe(`${trimBaseUrl(base)}/models`, ctx);
      if ('error' in res) return result('unreachable');
      const keyResult = fromStatus(res.status);
      if (!keyResult.ok || !model) return keyResult;
      const listed = listedModelIds(res.body);
      if (!listed) return result('model_unchecked');
      // Gemini's OpenAI-compatible list names its models `models/<id>`.
      const found = listed.has(model) || listed.has(`models/${model}`);
      return found ? keyResult : result('unknown_model');
    }
    default:
      return result('misconfigured');
  }
}

/** Pull a non-secret remaining-credit number out of Suno's credit response, if present. */
function extractSunoCredits(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === 'object' && body !== null) {
    const data = (body as { data?: unknown }).data;
    if (typeof data === 'number') return { credits: data };
  }
  return undefined;
}
