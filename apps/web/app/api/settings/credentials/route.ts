// Admin-only: store/update/delete a provider credential (encrypted at rest), and
// read the Cover key state the Text AI's key decides. The route's admin guard
// authorizes every method; a Member is refused.
// Secrets are encrypted via the AES key and never echoed back.

import { NextResponse } from 'next/server';
import {
  deleteProviderCredential,
  envFieldVariables,
  getCredentialStatus,
  getStoredProviderConfig,
  getUnitCosts,
  readEnvLayer,
  resolveSharedImageKey,
  selectProviderKey,
  updateUnitCosts,
  upsertProviderCredential,
  type ProviderConfig,
} from '@liedmotif/db';
import {
  isBlockedValidationTargetResolved,
  normalizeProviderBaseUrl,
  type ProviderBaseUrlRejection,
} from '@liedmotif/providers';
import {
  configurableProviderMeta,
  followedCoverUnitCost,
  isConfigurableProviderType,
} from '@/lib/configurable-providers';
import { encryptionKeyIfConfigured } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { badRequest } from '@/lib/http';
import { readJsonObjectBody, requireAdminOwnerId } from '@/lib/api-response';
import { loadCoverKeyState } from '@/lib/provider-settings-data';

export const dynamic = 'force-dynamic';

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** What the admin has to change, per reason a base URL cannot be stored. */
const BASE_URL_REFUSALS: Record<ProviderBaseUrlRejection, string> = {
  not_http_url: 'That base URL must be a full http:// or https:// address.',
  carries_authentication:
    'That base URL cannot carry a username, password, query, or fragment — put the API key in the API key field.',
};

const FIELD_NAMES = { apiKey: 'API key', baseUrl: 'base URL', model: 'model' } as const;

/**
 * The field a save tries to change although `.env` sets it, or `undefined`. The
 * env value is the one that runs, so a stored one would never be used. A base URL
 * or model equal to the env value only rides along. A key never does: the client
 * is never sent the env key, so any key or share request would replace it.
 */
function envOwnedFieldChanged(
  fromEnv: { apiKey?: string; baseUrl?: string; model?: string },
  sent: { secret?: string; sharesTextLlmKey: boolean; baseUrl?: string; model?: string },
): keyof typeof FIELD_NAMES | undefined {
  if (fromEnv.apiKey && (sent.secret || sent.sharesTextLlmKey)) return 'apiKey';
  if (fromEnv.baseUrl && sent.baseUrl !== undefined && sent.baseUrl !== fromEnv.baseUrl) {
    return 'baseUrl';
  }
  if (fromEnv.model && sent.model && sent.model !== fromEnv.model) return 'model';
  return undefined;
}

/**
 * The Cover key state as stored now (`loadCoverKeyState`), so a flow that just
 * saved its Text AI decides the Cover key from the server, not a picker.
 */
export async function GET(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ ok: true, ...(await loadCoverKeyState()) });
}

export async function POST(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;

  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;

  const providerType = body.providerType;
  const providerKey = body.providerKey;
  if (!isConfigurableProviderType(providerType) || typeof providerKey !== 'string') {
    return badRequest('providerType (music|llm|image) and providerKey are required.');
  }
  const providerMeta = configurableProviderMeta(providerType, providerKey);
  if (!providerMeta) return badRequest('Unsupported provider.');

  const secret = trimmed(body.secret);
  // Cover images using the Text AI's key: the image credential then keeps no key
  // of its own, so a later rotation on the Text AI card reaches Covers too.
  const sharesTextLlmKey = providerType === 'image' && body.shareTextLlmKey === true;
  if (sharesTextLlmKey && secret) {
    return badRequest('Send either an API key or shareTextLlmKey, not both.');
  }
  const fromEnv = readEnvLayer(providerType, providerKey);
  const lockedField = envOwnedFieldChanged(fromEnv, {
    secret,
    sharesTextLlmKey,
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined,
    model: trimmed(body.model),
  });
  if (lockedField) {
    const variable = envFieldVariables(providerType)[lockedField];
    return NextResponse.json(
      {
        ok: false,
        error: `The ${FIELD_NAMES[lockedField]} is set by ${variable} in .env, so it cannot be changed here.`,
      },
      { status: 409 },
    );
  }
  // A field `.env` sets is left out of the stored config, as the client leaves it out.
  const model = fromEnv.model ? undefined : trimmed(body.model);
  const displayName = trimmed(body.displayName) ?? providerKey;

  // Config is stored in plaintext and read back by the admin frontend, so a base
  // URL that carries its own authentication is refused here rather than
  // smuggling a secret out of the encrypted credential path.
  const sentBaseUrl = fromEnv.baseUrl ? undefined : body.baseUrl;
  const submittedBaseUrl = trimmed(sentBaseUrl);
  let baseUrl: string | undefined;
  if (submittedBaseUrl) {
    const normalized = normalizeProviderBaseUrl(submittedBaseUrl);
    if (!normalized.ok) return badRequest(BASE_URL_REFUSALS[normalized.reason]);
    baseUrl = normalized.baseUrl;
  }

  // SSRF guard at the PERSISTENCE boundary: a blocked base URL must never be
  // stored as config the adapters will later fetch. DNS-resolving, like the
  // validate route (the "Test connection" probe alone is advisory).
  if (baseUrl && (await isBlockedValidationTargetResolved(providerKey, baseUrl))) {
    return badRequest('That base URL host is not allowed.');
  }

  let encryptionKey: Buffer | undefined;
  try {
    encryptionKey = encryptionKeyIfConfigured();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Server credential key is misconfigured.' },
      { status: 500 },
    );
  }
  if (!encryptionKey) {
    return badRequest('CREDENTIAL_ENCRYPTION_KEY must be configured to store provider settings.');
  }

  // Config updates MERGE over the stored config (a base-URL-only save must not
  // wipe a stored model); with no config fields supplied the stored config is
  // kept untouched. An explicitly blank base URL is the one way to remove a
  // stored endpoint, so the provider default applies again.
  const clearsBaseUrl = typeof sentBaseUrl === 'string' && !submittedBaseUrl;
  const stored = await getStoredProviderConfig(getDb(), { providerType, providerKey });
  const { baseUrl: _storedBaseUrl, ...storedWithoutBaseUrl } = stored ?? {};
  const kept = clearsBaseUrl ? storedWithoutBaseUrl : (stored ?? {});
  const config: ProviderConfig | undefined =
    baseUrl || model || clearsBaseUrl
      ? {
          ...kept,
          ...(baseUrl ? { baseUrl } : {}),
          ...(model ? { model } : {}),
        }
      : undefined;

  // An LLM without a model can never be built (`buildLlmProvider` returns null),
  // so reject a save whose effective config would leave the LLM unusable. A preset
  // with a runtime model default (openai) is buildable model-less, and an
  // `.env` model wins at build time.
  const llmMeta = providerType === 'llm' ? providerMeta : undefined;
  const storedModel = typeof stored?.model === 'string' ? stored.model.trim() : '';
  const effectiveModel = model ?? (storedModel || fromEnv.model || llmMeta?.defaultModel);
  if (providerType === 'llm' && !effectiveModel) {
    return badRequest('A model is required for this Text AI provider.');
  }

  // The generic preset has no endpoint default (Ollama falls back to localhost),
  // so without a base URL anywhere it would be the selected LLM while its builder
  // returns null and Sessions silently compile without it.
  const storedBaseUrl = clearsBaseUrl ? undefined : trimmed(stored?.baseUrl);
  const effectiveBaseUrl = baseUrl ?? storedBaseUrl ?? fromEnv.baseUrl;
  if (providerType === 'llm' && providerKey === 'openai-compatible' && !effectiveBaseUrl) {
    return badRequest('A base URL is required for this Text AI provider.');
  }

  // Same invariant for the key: a key-requiring LLM or image preset saved with no
  // secret anywhere (form, DB, env, or the Text AI key an image preset shares)
  // would register as the selected provider (`selectProviderKey`) while its
  // builder returns null — a confusing half-configured row. Presets whose model
  // default made the save guard passable (openai) hit this with a completely
  // empty form, so enforce it at the same boundary. A save that shares the Text
  // AI key drops the stored one, so only the shared key counts for it.
  if (providerType !== 'music' && providerMeta.needsKey && !secret) {
    const keyResolves = sharesTextLlmKey
      ? Boolean(
          await resolveSharedImageKey(getDb(), providerKey, { encryptionKey }).catch(() => null),
        )
      : (await getCredentialStatus(getDb(), { providerType, providerKey, encryptionKey }))
          .configured;
    if (!keyResolves) return badRequest('An API key is required for this provider.');
  }

  await upsertProviderCredential(getDb(), {
    providerType,
    providerKey,
    displayName,
    secret: sharesTextLlmKey ? null : secret,
    config,
    encryptionKey,
  });

  // A provider `.env` outranks is only a fallback row: Covers keep their price.
  if (
    providerType === 'image' &&
    selectProviderKey('image', process.env, providerKey) === providerKey
  ) {
    const current = (await getUnitCosts(getDb())).perCoverUsd;
    const perCoverUsd = followedCoverUnitCost(current, providerKey);
    if (perCoverUsd !== current) await updateUnitCosts(getDb(), { perCoverUsd });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;
  const providerKey = trimmed(body.providerKey);
  if (body.providerType !== 'llm' || !providerKey) {
    return badRequest('providerType (llm) and providerKey are required.');
  }
  const deleted = await deleteProviderCredential(getDb(), {
    providerType: 'llm',
    providerKey,
  });
  return NextResponse.json({ ok: true, deleted });
}
