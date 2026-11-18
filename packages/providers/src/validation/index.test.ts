import { describe, expect, it } from 'vitest';
import { validateCredential } from './index';

/** A `fetch` stub that returns a fixed response and records the request. */
function stubFetch(status: number, body: unknown = {}) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    redirect?: 'follow' | 'error' | 'manual';
  }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: String(url), headers, redirect: init?.redirect });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SECRET = 'sk-suno-supersecret-9999';

describe('validateCredential — music/suno (credit check inside the adapter)', () => {
  it('returns ok when the Suno credit endpoint accepts the key', async () => {
    const { impl, calls } = stubFetch(200, { code: 200, msg: 'success', data: 42 });
    const result = await validateCredential({
      providerType: 'music',
      providerKey: 'suno',
      secret: SECRET,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('ok');
    // It actually called the Suno credit endpoint with a bearer header.
    expect(calls[0]?.url).toContain('/api/v1/generate/credit');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('maps 401 to a sanitized unauthorized result (no raw provider error)', async () => {
    const { impl } = stubFetch(401, { error: 'invalid api key: sk-leak-me' });
    const result = await validateCredential({
      providerType: 'music',
      providerKey: 'suno',
      secret: SECRET,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unauthorized');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-leak-me');
    expect(serialized).not.toContain(SECRET);
  });

  it('maps an unexpected status without leaking the body', async () => {
    const { impl } = stubFetch(500, { stack: 'internal trace sk-leak' });
    const result = await validateCredential({
      providerType: 'music',
      providerKey: 'suno',
      secret: SECRET,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unexpected_status');
    expect(JSON.stringify(result)).not.toContain('sk-leak');
  });

  it('does not follow redirects and treats a 3xx as unexpected (SSRF defense)', async () => {
    const { impl, calls } = stubFetch(302, {});
    const result = await validateCredential({
      providerType: 'music',
      providerKey: 'suno',
      secret: SECRET,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unexpected_status');
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('maps a network failure to unreachable (no thrown error escapes)', async () => {
    const impl = (async () => {
      throw new Error(`connect ECONNREFUSED with key ${SECRET}`);
    }) as unknown as typeof fetch;
    const result = await validateCredential({
      providerType: 'music',
      providerKey: 'suno',
      secret: SECRET,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreachable');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('flags a missing secret as misconfigured before any network call', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'music',
      providerKey: 'suno',
      secret: '',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('misconfigured');
    expect(calls).toHaveLength(0);
  });
});

describe('validateCredential — text LLM presets', () => {
  it('validates an Ollama base URL with no key (lists tags)', async () => {
    const { impl, calls } = stubFetch(200, { models: [] });
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain('/api/tags');
  });

  it('returns the installed Ollama model names for the model picker', async () => {
    const { impl } = stubFetch(200, {
      models: [
        { name: 'qwen3:8b', size: 1 },
        { name: 'llama3.1:latest' },
        { name: 42 },
        { model: 'no-name' },
        { name: '   ' },
      ],
    });
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'ollama',
      baseUrl: 'http://localhost:11434',
      fetchImpl: impl,
    });
    expect(result.detail).toEqual({ models: ['qwen3:8b', 'llama3.1:latest'] });
  });

  it('requires a base URL for the generic openai-compatible preset', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openai-compatible',
      secret: 'sk-key',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('misconfigured');
    expect(calls).toHaveLength(0);
  });

  it('requires an API key for the generic openai-compatible preset (no false positive)', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('misconfigured');
    expect(calls).toHaveLength(0);
  });

  it('validates the hosted openai preset against its fixed models endpoint', async () => {
    const { impl, calls } = stubFetch(200, { data: [] });
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openai',
      secret: 'sk-oai-1',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-oai-1');
  });

  it('requires an API key for the hosted openai preset (no false positive)', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openai',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('misconfigured');
    expect(calls).toHaveLength(0);
  });
});

/** A `fetch` stub answering by URL suffix, so a key check and a model check can differ. */
function routedFetch(routes: Array<[suffix: string, status: number, body?: unknown]>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const route = routes.find(([suffix]) => String(url).endsWith(suffix));
    return new Response(JSON.stringify(route?.[2] ?? {}), { status: route?.[1] ?? 500 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('validateCredential — text LLM key and model, told apart', () => {
  it("checks an OpenRouter key on its key endpoint, then the model's catalog entry", async () => {
    const { impl, calls } = stubFetch(200, { data: {} });
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openrouter',
      secret: 'sk-or-123',
      model: ' openai/gpt-5-mini:nitro ',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('ok');
    expect(calls.map((call) => call.url)).toEqual([
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/model/openai/gpt-5-mini%3Anitro',
    ]);
    expect(calls.every((call) => call.headers.authorization === 'Bearer sk-or-123')).toBe(true);
  });

  it('reports a wrong OpenRouter key as unauthorized without asking about the model', async () => {
    const { impl, calls } = routedFetch([['/key', 401]]);
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openrouter',
      secret: 'sk-or-wrong',
      model: 'openai/gpt-5-mini',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('unauthorized');
    expect(calls).toHaveLength(1);
  });

  it('reports a model OpenRouter has no catalog entry for as an unknown model', async () => {
    const { impl } = routedFetch([
      ['/key', 200],
      ['/model/openai/gpt-5-mni', 404],
    ]);
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openrouter',
      secret: 'sk-or-123',
      model: 'openai/gpt-5-mni',
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_model' });
  });

  it('refuses an OpenRouter model ID without a vendor prefix without looking it up', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openrouter',
      secret: 'sk-or-123',
      model: 'gpt-5-mini',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('unknown_model');
    expect(calls).toHaveLength(1);
  });

  it('retrieves the OpenAI model by ID with the key, telling a bad key from an unknown model', async () => {
    const ok = stubFetch(200, { id: 'gpt-5-mini', object: 'model' });
    const verified = await validateCredential({
      providerType: 'llm',
      providerKey: 'openai',
      secret: 'sk-oai-1',
      model: 'gpt-5-mini',
      fetchImpl: ok.impl,
    });
    expect(verified.reason).toBe('ok');
    expect(ok.calls.map((call) => call.url)).toEqual([
      'https://api.openai.com/v1/models/gpt-5-mini',
    ]);
    expect(ok.calls[0]?.headers.authorization).toBe('Bearer sk-oai-1');

    const input = {
      providerType: 'llm',
      providerKey: 'openai',
      secret: 'sk-oai-1',
      model: 'x',
    } as const;
    expect((await validateCredential({ ...input, fetchImpl: stubFetch(401).impl })).reason).toBe(
      'unauthorized',
    );
    expect((await validateCredential({ ...input, fetchImpl: stubFetch(404).impl })).reason).toBe(
      'unknown_model',
    );
  });

  it("finds the model in an OpenAI-compatible endpoint's model list", async () => {
    const list = { object: 'list', data: [{ id: 'llama-3.3-70b' }, { id: 'qwen3-32b' }] };
    const input = {
      providerType: 'llm',
      providerKey: 'openai-compatible',
      secret: 'sk-x',
      baseUrl: 'https://llm.example.com/v1/',
    } as const;
    const listed = stubFetch(200, list);
    const found = await validateCredential({
      ...input,
      model: 'qwen3-32b',
      fetchImpl: listed.impl,
    });
    expect(found.reason).toBe('ok');
    expect(listed.calls[0]?.url).toBe('https://llm.example.com/v1/models');

    const missing = await validateCredential({
      ...input,
      model: 'qwen3-23b',
      fetchImpl: stubFetch(200, list).impl,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'unknown_model' });

    const rejected = await validateCredential({
      ...input,
      model: 'qwen3-32b',
      fetchImpl: stubFetch(401).impl,
    });
    expect(rejected.reason).toBe('unauthorized');
  });

  it("checks a Gemini key on Google's model list and finds a model listed as models/<id>", async () => {
    const list = {
      object: 'list',
      data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-4-argon' }],
    };
    const input = { providerType: 'llm', providerKey: 'gemini', secret: 'AIza-1' } as const;
    const listed = stubFetch(200, list);
    const found = await validateCredential({
      ...input,
      model: 'gemini-3.8-flash',
      fetchImpl: listed.impl,
    });
    expect(found.reason).toBe('ok');
    expect(listed.calls).toHaveLength(1);
    expect(listed.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    );
    expect(listed.calls[0]?.headers.authorization).toBe('Bearer AIza-1');

    const missing = await validateCredential({
      ...input,
      model: 'gemini-9-flash',
      fetchImpl: stubFetch(200, list).impl,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'unknown_model' });

    const rejected = await validateCredential({
      ...input,
      model: 'gemini-3.8-flash',
      fetchImpl: stubFetch(401).impl,
    });
    expect(rejected.reason).toBe('unauthorized');

    const keyless = stubFetch(200, list);
    const withoutKey = await validateCredential({
      providerType: 'llm',
      providerKey: 'gemini',
      fetchImpl: keyless.impl,
    });
    expect(withoutKey.reason).toBe('misconfigured');
    expect(keyless.calls).toHaveLength(0);
  });

  it('passes the key but leaves the model unchecked when the endpoint lists no models', async () => {
    const result = await validateCredential({
      providerType: 'llm',
      providerKey: 'openai-compatible',
      secret: 'sk-x',
      baseUrl: 'https://llm.example.com/v1',
      model: 'qwen3-32b',
      fetchImpl: stubFetch(200, { status: 'ok' }).impl,
    });
    expect(result).toMatchObject({ ok: true, reason: 'model_unchecked' });
  });

  it('reports a model Ollama has not pulled as unknown, matching an implicit :latest tag', async () => {
    const tags = { models: [{ name: 'llama3.1:latest' }, { name: 'qwen3:8b' }] };
    const input = {
      providerType: 'llm',
      providerKey: 'ollama',
      baseUrl: 'http://localhost:11434',
    } as const;
    const latest = await validateCredential({
      ...input,
      model: 'llama3.1',
      fetchImpl: stubFetch(200, tags).impl,
    });
    expect(latest.reason).toBe('ok');
    const missing = await validateCredential({
      ...input,
      model: 'qwen3:14b',
      fetchImpl: stubFetch(200, tags).impl,
    });
    expect(missing).toMatchObject({
      ok: false,
      reason: 'unknown_model',
      detail: { models: ['llama3.1:latest', 'qwen3:8b'] },
    });
  });
});

describe('validateCredential — image/openrouter (the free key check, never a generation)', () => {
  it("checks the key against OpenRouter's key endpoint with the bearer key", async () => {
    const { impl, calls } = stubFetch(200, { data: { label: 'sk-or-v1-abc...' } });
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'sk-or-img',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-or-img');
  });

  it('reports a key OpenRouter does not know as unauthorized', async () => {
    const { impl } = stubFetch(401, { error: { message: 'User not found.', code: 401 } });
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'sk-or-wrong',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('unauthorized');
  });

  it('checks the entered model against OpenRouter once the key passes', async () => {
    const { impl, calls } = stubFetch(200, { data: {} });
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'sk-or-img',
      model: ' google/gemini-3.1-flash-image ',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/images/models/google/gemini-3.1-flash-image/endpoints',
    ]);
    expect(calls[1]?.headers.authorization).toBe('Bearer sk-or-img');
  });

  it('reports a model OpenRouter has no image endpoint for as an unknown model', async () => {
    const impl = (async (url: string | URL) =>
      new Response('{}', { status: String(url).endsWith('/key') ? 200 : 404 })) as typeof fetch;
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'sk-or-img',
      model: 'google/no-such-image-model',
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_model' });
    expect(result.message).toMatch(/model/i);
  });

  it('refuses a malformed model ID without asking OpenRouter about it', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openrouter',
      secret: 'sk-or-img',
      model: 'no-vendor-prefix',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('unknown_model');
    expect(calls).toHaveLength(1);
  });

  it('flags a missing key as misconfigured before any network call', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openrouter',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('misconfigured');
    expect(calls).toHaveLength(0);
  });
});

describe('validateCredential — image/openai (free model lookups, never a generation)', () => {
  it('retrieves the image model with the bearer key', async () => {
    const { impl, calls } = stubFetch(200, { id: 'gpt-image-2.6-flare', object: 'model' });
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openai',
      secret: 'sk-proj-img',
      model: ' gpt-image-2.6-flare ',
      fetchImpl: impl,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models/gpt-image-2.6-flare');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-proj-img');
  });

  it('tells a bad key from a model the key cannot see', async () => {
    const unauthorized = await validateCredential({
      providerType: 'image',
      providerKey: 'openai',
      secret: 'sk-wrong',
      model: 'gpt-image-2.6-flare',
      fetchImpl: stubFetch(401).impl,
    });
    expect(unauthorized.reason).toBe('unauthorized');
    const unknown = await validateCredential({
      providerType: 'image',
      providerKey: 'openai',
      secret: 'sk-proj-img',
      model: 'gpt-image-9',
      fetchImpl: stubFetch(404).impl,
    });
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown_model' });
  });

  it('flags a missing key as misconfigured before any network call', async () => {
    const { impl, calls } = stubFetch(200);
    const result = await validateCredential({
      providerType: 'image',
      providerKey: 'openai',
      model: 'gpt-image-2.6-flare',
      fetchImpl: impl,
    });
    expect(result.reason).toBe('misconfigured');
    expect(calls).toHaveLength(0);
  });
});

describe('validateCredential — unsupported requirement', () => {
  it('reports misconfigured for a provider it cannot validate', async () => {
    const result = await validateCredential({
      providerType: 'storage',
      providerKey: 'local-fs',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('misconfigured');
  });
});
