import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeEncryptionKey } from './crypto';
import {
  deleteProviderCredential,
  getCredentialStatus,
  getStoredProviderConfig,
  listCredentialStatuses,
  resolveImageRuntimeConfig,
  resolveLlmRuntimeConfig,
  resolveMusicRuntimeConfig,
  resolveProviderCredential,
  setCredentialValidation,
  upsertProviderCredential,
  type CredentialRef,
} from './repo';
import { providerCredentials } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const KEY = decodeEncryptionKey(Buffer.alloc(32, 3).toString('base64'));
const EMPTY_ENV: NodeJS.ProcessEnv = {};

/** The raw secret the shared resolver yields for one requirement. */
async function resolvedSecret(
  db: TestDb['db'],
  ref: CredentialRef & { env?: NodeJS.ProcessEnv; encryptionKey?: Buffer },
): Promise<string | null> {
  const credential = await resolveProviderCredential(db, {
    providerType: ref.providerType,
    providerKey: ref.providerKey,
    env: ref.env,
  });
  return credential?.readApiKey(ref.encryptionKey) ?? null;
}

describeIfDb('provider credential repository (env overrides DB, masked never raw)', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-credentials-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['provider_credentials']);
  });

  it('stores an encrypted secret and reports it as a DB-sourced, masked credential', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });

    const status = await getCredentialStatus(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env: EMPTY_ENV,
      encryptionKey: KEY,
    });

    expect(status.configured).toBe(true);
    expect(status.source).toBe('database');
    expect(status.masked).toBe('••••1234');
    // The status object must never carry the raw secret.
    expect(JSON.stringify(status)).not.toContain('sk-suno-abcd1234');
  });

  it('persists the secret only as an encrypted envelope (no plaintext column)', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    const rows = await ctx.db.select().from(providerCredentials);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.encryptedSecret)).not.toContain('sk-suno-abcd1234');
    expect(rows[0]?.source).toBe('database');
  });

  it('decrypts the raw secret only via the server-only resolver', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    const secret = await resolvedSecret(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env: EMPTY_ENV,
      encryptionKey: KEY,
    });
    expect(secret).toBe('sk-suno-abcd1234');
  });

  it('lets an env var override the DB credential and labels the source env', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-db-value-0000',
      encryptionKey: KEY,
    });
    const env = { SUNO_API_KEY: 'sk-env-value-9999' };

    const status = await getCredentialStatus(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env,
      encryptionKey: KEY,
    });
    expect(status.source).toBe('env');
    expect(status.masked).toBe('••••9999');

    const secret = await resolvedSecret(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env,
      encryptionKey: KEY,
    });
    expect(secret).toBe('sk-env-value-9999');
  });

  it('resolves an env-sourced status without an encryption key', async () => {
    const status = await getCredentialStatus(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env: { SUNO_API_KEY: 'sk-env-only-5555' },
      // no encryptionKey: env masking needs no decryption
    });
    expect(status.source).toBe('env');
    expect(status.masked).toBe('••••5555');
  });

  it('throws when a DB-stored secret is read without the encryption key', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    await expect(
      resolvedSecret(ctx.db, { providerType: 'music', providerKey: 'suno', env: EMPTY_ENV }),
    ).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('degrades (does not throw) when a stored secret cannot be decrypted', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    const wrongKey = decodeEncryptionKey(Buffer.alloc(32, 9).toString('base64'));

    // Status path degrades: still "configured (database)", just no preview.
    const status = await getCredentialStatus(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env: EMPTY_ENV,
      encryptionKey: wrongKey,
    });
    expect(status.configured).toBe(true);
    expect(status.source).toBe('database');
    expect(status.masked).toBeNull();
    expect(status.decryptError).toBe(true);

    // ...but the server-only secret resolver stays fail-loud.
    await expect(
      resolvedSecret(ctx.db, {
        providerType: 'music',
        providerKey: 'suno',
        env: EMPTY_ENV,
        encryptionKey: wrongKey,
      }),
    ).rejects.toThrow();
  });

  it('reports an unconfigured credential when neither env nor DB has it', async () => {
    const status = await getCredentialStatus(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      env: EMPTY_ENV,
      encryptionKey: KEY,
    });
    expect(status.configured).toBe(false);
    expect(status.source).toBeNull();
    expect(status.masked).toBeNull();
  });

  it('upserts in place — re-saving the same provider never duplicates the row', async () => {
    const base = {
      providerType: 'music' as const,
      providerKey: 'suno',
      displayName: 'Suno',
      encryptionKey: KEY,
    };
    await upsertProviderCredential(ctx.db, { ...base, secret: 'sk-first-0001' });
    await upsertProviderCredential(ctx.db, {
      ...base,
      displayName: 'Suno (prod)',
      secret: 'sk-second-0002',
    });

    const rows = await ctx.db.select().from(providerCredentials);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe('Suno (prod)');

    const secret = await resolvedSecret(ctx.db, {
      ...base,
      env: EMPTY_ENV,
    });
    expect(secret).toBe('sk-second-0002');
  });

  it('replaces the previous LLM row when a different LLM provider is saved (single-LLM invariant)', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      secret: 'sk-or-1111',
      config: { model: 'minimax/minimax-m2.7' },
      encryptionKey: KEY,
    });
    // Switching to Ollama must not leave the OpenRouter row behind — otherwise
    // "which LLM is configured" becomes a multi-row (query-plan-dependent) question.
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'ollama',
      displayName: 'Ollama',
      config: { model: 'llama3.1', baseUrl: 'http://localhost:11434' },
    });

    const rows = await ctx.db.select().from(providerCredentials);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerKey).toBe('ollama');
  });

  it('enforces the single-LLM invariant at the database boundary (unique index)', async () => {
    // Two owner-less LLM rows with DIFFERENT provider keys are legal under the
    // per-(type,key) index — the singleton index must reject the second anyway,
    // so even interleaved saves (which bypass the upsert's delete) cannot
    // recreate a multi-row state.
    await ctx.db.insert(providerCredentials).values({
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      source: 'database',
    });
    // Drizzle wraps the pg error; the violated constraint sits on the cause.
    await expect(
      ctx.db.insert(providerCredentials).values({
        providerType: 'llm',
        providerKey: 'ollama',
        displayName: 'Ollama',
        source: 'database',
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        constraint: 'provider_credentials_instance_llm_singleton',
      }),
    });
  });

  it('keeps one Cover images credential: saving another image provider drops the old key', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'image',
      providerKey: 'openai',
      displayName: 'OpenAI',
      secret: 'sk-old-cover-key-1234',
      encryptionKey: KEY,
    });
    await upsertProviderCredential(ctx.db, {
      providerType: 'image',
      providerKey: 'gemini',
      displayName: 'Gemini',
      secret: 'AIza-cover-key-5678',
      encryptionKey: KEY,
    });

    const rows = await ctx.db.select().from(providerCredentials);
    expect(rows.map((row) => `${row.providerType}:${row.providerKey}`)).toEqual(['image:gemini']);
    expect(
      await getCredentialStatus(ctx.db, {
        providerType: 'image',
        providerKey: 'openai',
        env: EMPTY_ENV,
        encryptionKey: KEY,
      }),
    ).toMatchObject({ configured: false });
  });

  it('leaves other provider types alone when replacing the LLM row', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      config: { model: 'minimax/minimax-m2.7' },
    });

    const rows = await ctx.db.select().from(providerCredentials);
    expect(rows.map((row) => row.providerType).sort()).toEqual(['llm', 'music']);
  });

  it('returns the stored non-secret config, or null when absent', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      config: { model: 'minimax/minimax-m2.7', baseUrl: 'https://example.test/v1' },
    });

    expect(
      await getStoredProviderConfig(ctx.db, { providerType: 'llm', providerKey: 'openrouter' }),
    ).toEqual({ model: 'minimax/minimax-m2.7', baseUrl: 'https://example.test/v1' });
    expect(
      await getStoredProviderConfig(ctx.db, { providerType: 'music', providerKey: 'suno' }),
    ).toBeNull();
  });

  it('records a sanitized validation status', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    await setCredentialValidation(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      status: 'ok',
    });
    const status = await getCredentialStatus(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      env: EMPTY_ENV,
      encryptionKey: KEY,
    });
    expect(status.validationStatus).toBe('ok');
    expect(status.lastValidatedAt).toBeInstanceOf(Date);
  });

  it('summarizes a set of requirements with per-source labels', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });
    const statuses = await listCredentialStatuses(
      ctx.db,
      [
        { providerType: 'music', providerKey: 'suno' },
        { providerType: 'llm', providerKey: 'openrouter' },
      ],
      { env: { LLM_PROVIDER: 'openrouter', LLM_API_KEY: 'sk-llm-7777' }, encryptionKey: KEY },
    );
    const bySource = Object.fromEntries(statuses.map((s) => [s.providerKey, s.source]));
    expect(bySource.suno).toBe('database');
    expect(bySource.openrouter).toBe('env');
  });

  it('does not mis-attribute the env LLM key to a different DB provider', async () => {
    // DB has an OpenRouter credential; env configures a DIFFERENT provider (Ollama).
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      secret: 'sk-db-openrouter-1111',
      encryptionKey: KEY,
    });
    const env = { LLM_PROVIDER: 'ollama', LLM_API_KEY: 'sk-env-ollama-2222' };

    // The env key belongs to Ollama, so the DB OpenRouter credential still wins for
    // OpenRouter and is labeled `database` (not falsely `env`).
    const openrouter = await getCredentialStatus(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      env,
      encryptionKey: KEY,
    });
    expect(openrouter.source).toBe('database');

    // Ollama, the env-declared provider, resolves from env.
    const ollama = await getCredentialStatus(ctx.db, {
      providerType: 'llm',
      providerKey: 'ollama',
      env,
      encryptionKey: KEY,
    });
    expect(ollama.source).toBe('env');
  });

  it('deletes only the exact stored provider credential', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      secret: 'sk-db-openrouter-1111',
      encryptionKey: KEY,
    });
    await upsertProviderCredential(ctx.db, {
      providerType: 'music',
      providerKey: 'suno',
      displayName: 'Suno',
      secret: 'sk-suno-abcd1234',
      encryptionKey: KEY,
    });

    await expect(
      deleteProviderCredential(ctx.db, { providerType: 'llm', providerKey: 'openrouter' }),
    ).resolves.toBe(true);
    await expect(
      getStoredProviderConfig(ctx.db, { providerType: 'llm', providerKey: 'openrouter' }),
    ).resolves.toBeNull();
    expect(await ctx.db.select().from(providerCredentials)).toHaveLength(1);
  });

  describe('music runtime config (env first, the key saved in the app fills the gap)', () => {
    async function saveSunoKey(config?: { baseUrl: string }) {
      await upsertProviderCredential(ctx.db, {
        providerType: 'music',
        providerKey: 'suno',
        displayName: 'Suno-compatible',
        secret: 'sk-saved-in-app-1234',
        ...(config ? { config } : {}),
        encryptionKey: KEY,
      });
    }

    it('uses the key saved in onboarding when the env sets none', async () => {
      await saveSunoKey({ baseUrl: 'https://suno.example.com' });

      await expect(
        resolveMusicRuntimeConfig(ctx.db, {
          providerKey: 'suno',
          env: EMPTY_ENV,
          encryptionKey: KEY,
        }),
      ).resolves.toEqual({ apiKey: 'sk-saved-in-app-1234', baseUrl: 'https://suno.example.com' });
    });

    it('lets every SUNO_* env value win over the saved credential', async () => {
      await saveSunoKey({ baseUrl: 'https://saved.example.com' });

      await expect(
        resolveMusicRuntimeConfig(ctx.db, {
          providerKey: 'suno',
          env: {
            SUNO_API_KEY: ' sk-env-9999 ',
            SUNO_BASE_URL: 'https://env.example.com',
            SUNO_MODEL: 'V5',
            SUNO_CALLBACK_URL: 'https://cb.example.com/hook',
          },
          encryptionKey: KEY,
        }),
      ).resolves.toEqual({
        apiKey: 'sk-env-9999',
        baseUrl: 'https://env.example.com',
        model: 'V5',
        callbackUrl: 'https://cb.example.com/hook',
      });
    });

    it('fills only the fields the env leaves unset', async () => {
      await saveSunoKey({ baseUrl: 'https://saved.example.com' });

      await expect(
        resolveMusicRuntimeConfig(ctx.db, {
          providerKey: 'suno',
          env: { SUNO_API_KEY: 'sk-env-9999', SUNO_BASE_URL: '  ' },
          encryptionKey: KEY,
        }),
      ).resolves.toEqual({ apiKey: 'sk-env-9999', baseUrl: 'https://saved.example.com' });
    });

    it('resolves no key when neither the env nor the app has one', async () => {
      await expect(
        resolveMusicRuntimeConfig(ctx.db, { providerKey: 'suno', env: EMPTY_ENV }),
      ).resolves.toEqual({});
    });
  });
  describe('llm runtime config (env names the provider, the saved row fills the gaps)', () => {
    it('resolves no LLM when neither the env nor the app names one', async () => {
      await expect(resolveLlmRuntimeConfig(ctx.db, { env: EMPTY_ENV })).resolves.toBeNull();
    });

    it('uses the saved provider, key and model when the env names none', async () => {
      await upsertProviderCredential(ctx.db, {
        providerType: 'llm',
        providerKey: 'openrouter',
        displayName: 'OpenRouter',
        secret: 'sk-or-saved',
        config: { model: 'saved/model' },
        encryptionKey: KEY,
      });
      await expect(
        resolveLlmRuntimeConfig(ctx.db, { env: EMPTY_ENV, encryptionKey: KEY }),
      ).resolves.toEqual({
        providerKey: 'openrouter',
        apiKey: 'sk-or-saved',
        settings: { model: 'saved/model', supportsStructuredOutputs: false },
      });
    });

    it('lets LLM_PROVIDER select the provider, with its LLM_* settings', async () => {
      await upsertProviderCredential(ctx.db, {
        providerType: 'llm',
        providerKey: 'openrouter',
        displayName: 'OpenRouter',
        secret: 'sk-or-saved',
        config: { model: 'saved/model' },
        encryptionKey: KEY,
      });
      await expect(
        resolveLlmRuntimeConfig(ctx.db, {
          env: { LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama3' },
          encryptionKey: KEY,
        }),
      ).resolves.toEqual({
        providerKey: 'ollama',
        apiKey: null,
        settings: { model: 'llama3', supportsStructuredOutputs: false },
      });
    });
  });

  describe('image runtime config (env first, the key saved in the app fills the gap)', () => {
    async function saveOpenRouterImageKey() {
      await upsertProviderCredential(ctx.db, {
        providerType: 'image',
        providerKey: 'openrouter',
        displayName: 'OpenRouter',
        secret: 'sk-or-saved-in-app',
        encryptionKey: KEY,
      });
    }

    it('uses the key saved in onboarding when the env names no image provider', async () => {
      await saveOpenRouterImageKey();

      await expect(
        resolveImageRuntimeConfig(ctx.db, { env: EMPTY_ENV, encryptionKey: KEY }),
      ).resolves.toEqual({ providerKey: 'openrouter', apiKey: 'sk-or-saved-in-app' });
    });

    it('fills the key from the app when IMAGE_PROVIDER is set without one', async () => {
      await saveOpenRouterImageKey();

      await expect(
        resolveImageRuntimeConfig(ctx.db, {
          env: { IMAGE_PROVIDER: 'openrouter', IMAGE_API_KEY: ' ', IMAGE_MODEL: 'env/model' },
          encryptionKey: KEY,
        }),
      ).resolves.toEqual({
        providerKey: 'openrouter',
        apiKey: 'sk-or-saved-in-app',
        model: 'env/model',
      });
    });

    it('lets the IMAGE_* env win over the saved key', async () => {
      await saveOpenRouterImageKey();

      await expect(
        resolveImageRuntimeConfig(ctx.db, {
          env: {
            IMAGE_PROVIDER: ' openrouter ',
            IMAGE_API_KEY: ' sk-or-env ',
            IMAGE_MODEL: ' env/model ',
            IMAGE_RESOLUTION: '2K',
            IMAGE_ASPECT_RATIO: '1:1',
            IMAGE_REQUEST_TIMEOUT_MS: '12000',
            IMAGE_SUPPORTED_PARAMS: ' seed,resolution ',
          },
          encryptionKey: KEY,
        }),
      ).resolves.toEqual({
        providerKey: 'openrouter',
        apiKey: 'sk-or-env',
        model: 'env/model',
        resolution: '2K',
        aspectRatio: '1:1',
        requestTimeoutMs: 12_000,
        supportedParams: 'seed,resolution',
      });
    });

    it('uses the model saved with the key, and a later save on the very next resolve', async () => {
      await upsertProviderCredential(ctx.db, {
        providerType: 'image',
        providerKey: 'openrouter',
        displayName: 'OpenRouter',
        secret: 'sk-or-saved-in-app',
        config: { model: 'saved/first' },
        encryptionKey: KEY,
      });
      await expect(
        resolveImageRuntimeConfig(ctx.db, { env: EMPTY_ENV, encryptionKey: KEY }),
      ).resolves.toMatchObject({ model: 'saved/first' });

      await upsertProviderCredential(ctx.db, {
        providerType: 'image',
        providerKey: 'openrouter',
        displayName: 'OpenRouter',
        config: { model: 'saved/second' },
      });
      await expect(
        resolveImageRuntimeConfig(ctx.db, { env: EMPTY_ENV, encryptionKey: KEY }),
      ).resolves.toEqual({
        providerKey: 'openrouter',
        apiKey: 'sk-or-saved-in-app',
        model: 'saved/second',
      });
      // IMAGE_MODEL still outranks the saved model.
      await expect(
        resolveImageRuntimeConfig(ctx.db, {
          env: { IMAGE_MODEL: 'env/model' },
          encryptionKey: KEY,
        }),
      ).resolves.toMatchObject({ model: 'env/model' });
    });

    describe("shared key: Cover images without a key use the text LLM's key of the same vendor", () => {
      async function saveLlm(
        providerKey: string,
        secret?: string,
        config?: Record<string, string>,
      ) {
        await upsertProviderCredential(ctx.db, {
          providerType: 'llm',
          providerKey,
          displayName: providerKey,
          ...(secret ? { secret } : {}),
          ...(config ? { config } : {}),
          encryptionKey: KEY,
        });
      }

      async function saveImage(providerKey: string, secret?: string) {
        await upsertProviderCredential(ctx.db, {
          providerType: 'image',
          providerKey,
          displayName: providerKey,
          ...(secret ? { secret } : {}),
          encryptionKey: KEY,
        });
      }

      const resolveImage = (env: NodeJS.ProcessEnv = EMPTY_ENV) =>
        resolveImageRuntimeConfig(ctx.db, { env, encryptionKey: KEY });

      it.each([
        ['openai', 'sk-proj-text'],
        ['gemini', 'AIza-text'],
        ['openrouter', 'sk-or-text'],
      ])(
        'shares the $0 text LLM key with a keyless image provider of that vendor',
        async (vendor, key) => {
          await saveLlm(vendor, key);
          await saveImage(vendor);

          await expect(resolveImage()).resolves.toEqual({ providerKey: vendor, apiKey: key });
        },
      );

      it('lets a key stored on the image credential win over the text LLM key', async () => {
        await saveLlm('openai', 'sk-proj-text');
        await saveImage('openai', 'sk-proj-image');

        await expect(resolveImage()).resolves.toMatchObject({ apiKey: 'sk-proj-image' });
      });

      it('lets IMAGE_API_KEY beside a matching IMAGE_PROVIDER win over the text LLM key', async () => {
        await saveLlm('gemini', 'AIza-text');

        await expect(
          resolveImage({ IMAGE_PROVIDER: 'gemini', IMAGE_API_KEY: 'AIza-image-env' }),
        ).resolves.toMatchObject({ providerKey: 'gemini', apiKey: 'AIza-image-env' });
      });

      it('never shares a key across vendors', async () => {
        await saveLlm('openai', 'sk-proj-text');
        await saveImage('gemini');

        await expect(resolveImage()).resolves.toEqual({ providerKey: 'gemini' });
      });

      it('shares no key while the text LLM runs on a base URL override', async () => {
        await saveLlm('openai', 'sk-proj-text', { baseUrl: 'https://proxy.example.org/v1' });
        await saveImage('openai');
        await expect(resolveImage()).resolves.toEqual({ providerKey: 'openai' });

        await saveLlm('openai', 'sk-proj-text', {});
        await expect(
          resolveImage({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'https://proxy.example.org/v1' }),
        ).resolves.toEqual({ providerKey: 'openai' });
      });

      it('lets a stored image credential use a text LLM key from .env', async () => {
        await saveImage('openrouter');

        await expect(
          resolveImage({ LLM_PROVIDER: 'openrouter', LLM_API_KEY: 'sk-or-env-text' }),
        ).resolves.toEqual({ providerKey: 'openrouter', apiKey: 'sk-or-env-text' });
      });

      it('shares LLM_API_KEY with IMAGE_PROVIDER of the same vendor in .env alone', async () => {
        await expect(
          resolveImage({
            LLM_PROVIDER: 'openai',
            LLM_API_KEY: 'sk-proj-env-text',
            IMAGE_PROVIDER: 'openai',
            IMAGE_API_KEY: '',
          }),
        ).resolves.toEqual({ providerKey: 'openai', apiKey: 'sk-proj-env-text' });
      });

      it('resolves no key once the text LLM is removed', async () => {
        await saveLlm('gemini', 'AIza-text');
        await saveImage('gemini');
        await deleteProviderCredential(ctx.db, { providerType: 'llm', providerKey: 'gemini' });

        await expect(resolveImage()).resolves.toEqual({ providerKey: 'gemini' });
      });

      it('reports the shared key in the Cover images status, masked', async () => {
        await saveLlm('openai', 'sk-proj-text-9876');
        await saveImage('openai');

        const status = await getCredentialStatus(ctx.db, {
          providerType: 'image',
          providerKey: 'openai',
          env: EMPTY_ENV,
          encryptionKey: KEY,
        });

        expect(status).toMatchObject({ configured: true, source: 'shared', masked: '••••9876' });
        expect(JSON.stringify(status)).not.toContain('sk-proj-text-9876');
      });

      it('removes the stored image key when the save shares the text LLM key', async () => {
        await saveLlm('gemini', 'AIza-text');
        await saveImage('gemini', 'AIza-image');

        await upsertProviderCredential(ctx.db, {
          providerType: 'image',
          providerKey: 'gemini',
          displayName: 'Gemini',
          secret: null,
        });

        await expect(resolveImage()).resolves.toMatchObject({ apiKey: 'AIza-text' });
      });

      it('keeps a mixed setup on separate keys whatever happens to the text LLM', async () => {
        await saveLlm('openai', 'sk-proj-text');
        await saveImage('gemini', 'AIza-image');
        await expect(resolveImage()).resolves.toMatchObject({ apiKey: 'AIza-image' });
        await expect(
          resolveLlmRuntimeConfig(ctx.db, { env: EMPTY_ENV, encryptionKey: KEY }),
        ).resolves.toMatchObject({ apiKey: 'sk-proj-text' });

        await saveLlm('gemini', 'AIza-text');
        await expect(resolveImage()).resolves.toMatchObject({ apiKey: 'AIza-image' });
        await deleteProviderCredential(ctx.db, { providerType: 'llm', providerKey: 'gemini' });
        await expect(resolveImage()).resolves.toMatchObject({ apiKey: 'AIza-image' });
      });
    });

    it('resolves no image provider when neither the env nor the app names one', async () => {
      await expect(resolveImageRuntimeConfig(ctx.db, { env: EMPTY_ENV })).resolves.toBeNull();
      // A bare key without IMAGE_PROVIDER stays inert: blank IMAGE_PROVIDER is the
      // documented way to make no paid image request.
      await expect(
        resolveImageRuntimeConfig(ctx.db, { env: { IMAGE_API_KEY: 'sk-or-env' } }),
      ).resolves.toBeNull();
    });
  });
});
