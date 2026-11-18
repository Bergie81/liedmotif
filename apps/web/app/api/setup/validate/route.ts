// Server-side provider credential validation for the settings credential editor.
//
// Admin-only and rate-limited. The provided secret is used ONLY server-side to
// make one sanitized check and is never logged or persisted here. The result is
// already sanitized by the provider-validation adapter (no raw provider
// errors/keys).

import { NextResponse } from 'next/server';
import {
  readEnvLayer,
  resolveProviderCredential,
  resolveProviderSettings,
  resolveSharedImageKey,
} from '@liedmotif/db';
import { isBlockedValidationTargetResolved, validateCredential } from '@liedmotif/providers';
import { configurableProviderMeta, isConfigurableProviderType } from '@/lib/configurable-providers';
import { credentialTestMessage } from '@/lib/credential-test-copy';
import { encryptionKeyIfConfigured } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { badRequest, clientIp, tooManyRequests } from '@/lib/http';
import { readJsonObjectBody, requireAdminOwnerId } from '@/lib/api-response';
import { validateLimiter } from '@/lib/request-limits';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  // Ahead of the guard so an unauthenticated flood is refused before it costs a
  // session read, and keyed per IP so one caller cannot spend another's budget.
  const limit = validateLimiter.check(clientIp(request));
  if (!limit.allowed) return tooManyRequests(limit.retryAfterMs);

  // Admin-only whatever the setup state — the wizard never probes, and an
  // unauthenticated caller would get an oracle for which providers are
  // configured plus, through the Ollama loopback exemption in the SSRF guard
  // below, a localhost port scanner.
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

  const typedSecret =
    typeof body.secret === 'string' && body.secret.trim() ? body.secret : undefined;
  const typedBaseUrl =
    typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl : undefined;
  const typedModel = typeof body.model === 'string' ? body.model.trim() : '';
  // The Cover images card set to the Text AI's key: tested as saving would store
  // it, without the image credential's own key.
  const sharesTextLlmKey = providerType === 'image' && body.shareTextLlmKey === true;
  if (sharesTextLlmKey && typedSecret) {
    return badRequest('Send either an API key or shareTextLlmKey, not both.');
  }

  // Test verifies the configuration that will actually run: the credential
  // generation resolves (env first, then the stored row, per field), with the
  // form's values standing in for what saving it would store — its model, and no
  // base URL once the field is cleared. A typed secret or base URL is tested as
  // typed (the wizard's type-before-save flow); a typed model still yields to the
  // env model that would outrank it. An image provider without a key of its own,
  // or set to share, tests the Text AI key it shares. The image key is checked against the
  // provider's own fixed endpoint, so an image credential resolves no base URL.
  const credential = await resolveProviderCredential(getDb(), { providerType, providerKey });
  const settings = resolveProviderSettings(providerType, providerKey, {
    ...credential?.config,
    ...(typedModel ? { model: typedModel } : {}),
    ...(typeof body.baseUrl === 'string' ? { baseUrl: undefined } : {}),
  });
  let secret = typedSecret;
  if (!secret) {
    try {
      const encryptionKey = encryptionKeyIfConfigured();
      // Sharing drops only the stored key; an `.env` key still outranks the share.
      secret = sharesTextLlmKey
        ? readEnvLayer(providerType, providerKey).apiKey
        : credential?.readApiKey(encryptionKey);
      if (!secret && providerType === 'image') {
        secret = await resolveSharedImageKey(getDb(), providerKey, { encryptionKey });
      }
    } catch {
      // A stored secret that cannot be decrypted (rotated/missing key) tests as
      // unconfigured — the settings page surfaces the decrypt error itself.
    }
  }
  const baseUrl = typedBaseUrl ?? settings.baseUrl;

  // SSRF guard on the EFFECTIVE base URL (typed or resolved): refuse a private/
  // metadata target for remote presets — resolving hostnames first, so a public
  // name pointing at a private IP (DNS rebinding) is refused too. Ollama keeps
  // its narrow loopback exemption (see `ssrf.ts`).
  if (await isBlockedValidationTargetResolved(providerKey, baseUrl)) {
    return badRequest('That base URL host is not allowed.');
  }

  const model = settings.model || providerMeta.defaultModel;

  const result = await validateCredential({
    providerType,
    providerKey,
    secret,
    baseUrl,
    ...(model ? { model } : {}),
  });

  return NextResponse.json({
    ok: result.ok,
    reason: result.reason,
    message:
      providerType === 'music'
        ? result.message
        : credentialTestMessage({
            reason: result.reason,
            message: result.message,
            providerLabel: providerMeta.label,
            needsKey: providerMeta.needsKey,
            kind: providerType,
            model,
          }),
    detail: result.detail,
  });
}
