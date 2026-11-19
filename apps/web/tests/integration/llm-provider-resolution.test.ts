import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { decodeEncryptionKey, upsertProviderCredential } from '@liedmotif/db';

// Regression: an LLM configured ONLY through the setup wizard /
// settings UI — provider, encrypted secret, model, and base URL all stored in the
// DB, with no `LLM_*` env vars — must resolve end-to-end into a buildable
// provider, and env vars must keep their documented override behavior.

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));

const { getLlmProvider } = await import('@/lib/providers/providers');

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const LLM_ENV_VARS = [
  'LLM_PROVIDER',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_BASE_URL',
  'LLM_SUPPORTS_STRUCTURED_OUTPUTS',
] as const;

describeIfDb('getLlmProvider (wizard-only DB config resolves to a usable provider)', () => {
  let ctx: TestDb;
  const savedEnv: Partial<Record<string, string>> = {};

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-web-llm-resolution-test');
    holder.db = ctx.db;
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['provider_credentials']);
    for (const name of LLM_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    savedEnv.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY_B64;
  });

  afterEach(() => {
    for (const name of [...LLM_ENV_VARS, 'CREDENTIAL_ENCRYPTION_KEY']) {
      const saved = savedEnv[name];
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  it('builds a real provider from a DB-only config (encrypted secret + model + baseUrl)', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openai-compatible',
      displayName: 'openai-compatible',
      secret: 'sk-db-secret-1234',
      config: { model: 'gpt-4o-mini', baseUrl: 'https://llm.example.test/v1' },
      encryptionKey: decodeEncryptionKey(KEY_B64),
    });

    const provider = await getLlmProvider();
    expect(provider).not.toBeNull();
    expect(provider?.providerKey).toBe('openai-compatible');
    expect(provider?.getCapabilities().model).toBe('gpt-4o-mini');
  });

  it('returns null for a stored LLM whose config lacks a model (unbuildable preset)', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      secret: 'sk-or-5678',
      config: { baseUrl: 'https://openrouter.example.test/v1' },
      encryptionKey: decodeEncryptionKey(KEY_B64),
    });
    expect(await getLlmProvider()).toBeNull();
  });

  it('lets the env model override the stored one for the env-named provider', async () => {
    await upsertProviderCredential(ctx.db, {
      providerType: 'llm',
      providerKey: 'ollama',
      displayName: 'Ollama',
      config: { model: 'db-model', baseUrl: 'http://ollama.example.test:11434' },
    });
    process.env.LLM_PROVIDER = 'ollama';
    process.env.LLM_MODEL = 'env-model';

    const provider = await getLlmProvider();
    expect(provider?.getCapabilities().model).toBe('env-model');
  });

  it('returns null when neither env nor the DB configures an LLM', async () => {
    expect(await getLlmProvider()).toBeNull();
  });
});
