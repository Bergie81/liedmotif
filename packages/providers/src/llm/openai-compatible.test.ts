import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import { ProviderError } from '../errors';
import {
  clampMaxRetries,
  createGeminiLlmProvider,
  createOllamaLlmProvider,
  createOpenAiLlmProvider,
  createOpenRouterLlmProvider,
} from './openai-compatible';
import { compileStructuredControls } from './template';

/** A `fetch` stub that returns a fixed response and records each request. */
function stubFetch(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A model whose calls always fail with the given error (auth/network failures). */
function throwingModel(error: Error): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw error;
    },
    async doStream() {
      throw error;
    },
  } as unknown as LanguageModel;
}

/** A minimal LanguageModelV4 that replays canned text, one per call (no network;
 *  the last entry repeats). Each call's serialized prompt is pushed onto
 *  `captured` for content assertions; `fakeModel` is the no-capture shorthand. */
function promptCapturingModel(texts: string[], captured: string[]): LanguageModel {
  let call = 0;
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate(options: { prompt?: unknown }) {
      captured.push(JSON.stringify(options.prompt ?? ''));
      const text = texts[Math.min(call, texts.length - 1)] ?? '';
      call += 1;
      return {
        finishReason: { unified: 'stop' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text', text }],
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('streaming not used');
    },
  } as unknown as LanguageModel;
}

function fakeModel(texts: string[]): LanguageModel {
  return promptCapturingModel(texts, []);
}

/** A model that records each call's `providerOptions` (reasoning-effort assertions)
 *  and replays canned text like `fakeModel`. */
function optionsCapturingModel(texts: string[], captured: unknown[]): LanguageModel {
  let call = 0;
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate(options: { providerOptions?: unknown }) {
      captured.push(options.providerOptions ?? null);
      const text = texts[Math.min(call, texts.length - 1)] ?? '';
      call += 1;
      return {
        finishReason: { unified: 'stop' },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text', text }],
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('streaming not used');
    },
  } as unknown as LanguageModel;
}

const SNAPSHOT_JSON = JSON.stringify({
  stylePrompt: 'mellow lofi beats',
  genreTags: ['lofi'],
  vocalMode: 'instrumental',
});

describe('LLM credential validation (network mocked)', () => {
  it('validates an Ollama endpoint against the native tags route, no key needed', async () => {
    const { impl, calls } = stubFetch(200, { models: [] });
    const provider = createOllamaLlmProvider({ model: 'llama3', fetchImpl: impl });
    const result = await provider.validateCredentials();
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain('/api/tags');
    expect(calls[0]?.url).not.toContain('/v1'); // validation uses the native root
  });

  it('validates OpenRouter with the bearer key and maps 401 to not-ok', async () => {
    const ok = stubFetch(200, { data: [] });
    const okProvider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      fetchImpl: ok.impl,
    });
    expect((await okProvider.validateCredentials()).ok).toBe(true);
    expect(ok.calls[0]?.headers.authorization).toBe('Bearer sk-or-1');

    const bad = stubFetch(401);
    const badProvider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      fetchImpl: bad.impl,
    });
    expect((await badProvider.validateCredentials()).ok).toBe(false);
  });

  it('refuses (without any fetch) a base URL that points at a private host — SSRF guard', async () => {
    const { impl, calls } = stubFetch(200);
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      baseUrl: 'http://169.254.169.254/v1', // cloud metadata endpoint
      fetchImpl: impl,
    });
    const result = await provider.validateCredentials();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not allowed/i);
    expect(calls).toHaveLength(0); // never reached the network
  });
});

describe('createOpenAiLlmProvider (hosted OpenAI preset)', () => {
  it('validates against the fixed api.openai.com models endpoint with the bearer key', async () => {
    const { impl, calls } = stubFetch(200, { data: [] });
    const provider = createOpenAiLlmProvider({ apiKey: 'sk-oai-1', fetchImpl: impl });
    expect((await provider.validateCredentials()).ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-oai-1');
  });

  it('defaults the model to gpt-6-luna and sends high reasoning effort on every call', async () => {
    const captured: unknown[] = [];
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      languageModel: optionsCapturingModel([SNAPSHOT_JSON], captured),
    });
    expect(provider.getCapabilities().model).toBe('gpt-6-luna');
    await provider.expandSessionIntent('chill study music');
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) {
      expect(options).toMatchObject({ openaiCompatible: { reasoningEffort: 'high' } });
    }
  });

  it('sends a configured reasoning effort instead of the default', async () => {
    const captured: unknown[] = [];
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      model: 'gpt-6',
      reasoningEffort: 'low',
      languageModel: optionsCapturingModel([SNAPSHOT_JSON], captured),
    });
    expect(provider.getCapabilities().model).toBe('gpt-6');
    await provider.expandSessionIntent('chill study music');
    expect(captured[0]).toMatchObject({ openaiCompatible: { reasoningEffort: 'low' } });
  });

  it('sends NO reasoning effort for an overridden model unless one is configured', async () => {
    // An explicitly chosen model may not accept `reasoning_effort` (e.g. a
    // non-reasoning model picked to cut cost) — the high default is paired
    // with the default model only, so generation must not fail on the override.
    const captured: unknown[] = [];
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      model: 'gpt-4o-mini',
      languageModel: optionsCapturingModel([SNAPSHOT_JSON], captured),
    });
    await provider.expandSessionIntent('chill study music');
    // Only the always-on strict opt-out — no reasoning entry of any shape.
    expect(captured[0]).toEqual({ openaiCompatible: { strictJsonSchema: false } });
  });
});

describe('OpenRouter reasoning effort', () => {
  it('sends the unified reasoning parameter when an effort is configured', async () => {
    // OpenRouter does not take the OpenAI-style `reasoning_effort` field; its
    // unified parameter is `reasoning: { effort }` in the request body, injected
    // via the preset-named provider-options key (the SDK adapter spreads unknown
    // keys under it verbatim into the body). Same LLM_REASONING_EFFORT
    // vocabulary as the openai preset.
    const captured: unknown[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'anthropic/claude-sonnet-5',
      reasoningEffort: 'medium',
      languageModel: optionsCapturingModel([SNAPSHOT_JSON], captured),
    });
    await provider.expandSessionIntent('chill study music');
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) {
      expect(options).toMatchObject({ openrouter: { reasoning: { effort: 'medium' } } });
    }
  });

  it('sends no reasoning options when no effort is configured', async () => {
    const captured: unknown[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'anthropic/claude-sonnet-5',
      languageModel: optionsCapturingModel([SNAPSHOT_JSON], captured),
    });
    await provider.expandSessionIntent('chill study music');
    // Only the always-on strict opt-out — no `openrouter` reasoning key.
    expect(captured[0]).toEqual({ openaiCompatible: { strictJsonSchema: false } });
  });
});

describe('structured-output wire format', () => {
  /** A `fetch` stub answering every generation call with the same canned
   *  chat-completions reply, recording each JSON request body. Real SDK model —
   *  these assertions are about the bytes it puts on the wire. */
  function stubGenerationWire(content: string) {
    const bodies: Array<Record<string, unknown>> = [];
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-6-luna',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { impl, bodies };
  }

  it('requests strict json_schema (not bare json_object) when structured outputs are on', async () => {
    // Hosted OpenAI rejects `json_object` mode outright unless the prompt
    // contains the word "JSON" — which the expansion prompt does not. The
    // configured structured-output support must therefore reach the SDK model
    // so it sends the schema-carrying `json_schema` response format.
    const { impl, bodies } = stubGenerationWire(SNAPSHOT_JSON);
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      supportsStructuredOutputs: true,
      fetchImpl: impl,
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.stylePrompt).toBe('mellow lofi beats');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const format = body.response_format as { type?: string; json_schema?: unknown };
      expect(format?.type).toBe('json_schema');
      expect(format?.json_schema).toBeTruthy();
    }
  });

  it('keeps the strict json_schema inside the accepted OpenAI subset', async () => {
    // Hosted OpenAI validates the schema itself and 400s the whole call on any
    // keyword outside its strict-mode subset. `propertyNames` is the live risk:
    // a `z.record(...)` key schema serializes to it, so a snapshot field with a
    // record shape leaking into the request schema rejects every expansion.
    const { impl, bodies } = stubGenerationWire(SNAPSHOT_JSON);
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      supportsStructuredOutputs: true,
      fetchImpl: impl,
    });
    await provider.expandSessionIntent('chill study music');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(JSON.stringify(body.response_format)).not.toContain('"propertyNames"');
      // Strict mode additionally demands every property be required (the
      // expansion schema's defaulted fields are deliberately optional), so the
      // schema must ride as non-strict json_schema.
      const format = body.response_format as { json_schema?: { strict?: boolean } };
      expect(format.json_schema?.strict).not.toBe(true);
    }
  });

  it('sends no response_format at all when structured outputs are off', async () => {
    // The JSON-in-text path is what makes an arbitrary model usable: it asks in
    // the prompt and parses the reply. Naming ANY response_format here would
    // hand back the 400 the flag exists to avoid — `json_object` for the same
    // missing-"JSON" reason, `json_schema` from a model that cannot honour it.
    const { impl, bodies } = stubGenerationWire(SNAPSHOT_JSON);
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      supportsStructuredOutputs: false,
      fetchImpl: impl,
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.stylePrompt).toBe('mellow lofi beats');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toHaveProperty('response_format');
    }
  });

  it('puts the configured reasoning effort on the wire', async () => {
    // The effort travels under an SDK-owned provider-options key, and only the
    // SDK's own mapping turns it into the `reasoning_effort` body field. A
    // renamed key still typechecks and still passes the unit assertions against
    // a fake model — it just silently stops billing the reasoning tier the
    // operator configured. Only the bytes prove it.
    const { impl, bodies } = stubGenerationWire(SNAPSHOT_JSON);
    const provider = createOpenAiLlmProvider({
      apiKey: 'sk-oai-1',
      reasoningEffort: 'high',
      fetchImpl: impl,
    });
    await provider.expandSessionIntent('chill study music');
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.reasoning_effort).toBe('high');
    }
  });
});

describe('createGeminiLlmProvider (hosted Gemini preset)', () => {
  /** Answers every generation call with the same chat-completions reply and
   *  records each request's URL and JSON body. */
  function stubGeminiWire(content: string) {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gemini-3.8-flash',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { impl, requests };
  }

  it("calls Google's OpenAI-compatible endpoint with the default model at low effort", async () => {
    const { impl, requests } = stubGeminiWire(SNAPSHOT_JSON);
    const provider = createGeminiLlmProvider({ apiKey: 'AIza-1', fetchImpl: impl });
    await provider.expandSessionIntent('chill study music');
    expect(requests.length).toBeGreaterThan(0);
    for (const { url, body } of requests) {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      expect(body.model).toBe('gemini-3.8-flash');
      expect(body.reasoning_effort).toBe('low');
    }
  });

  it('sends minimal instead of none, because Gemini cannot switch thinking off', async () => {
    const { impl, requests } = stubGeminiWire(SNAPSHOT_JSON);
    const provider = createGeminiLlmProvider({
      apiKey: 'AIza-1',
      reasoningEffort: 'none',
      fetchImpl: impl,
    });
    await provider.expandSessionIntent('chill study music');
    expect(requests.length).toBeGreaterThan(0);
    for (const { body } of requests) expect(body.reasoning_effort).toBe('minimal');
  });

  it('keeps a configured model and effort', async () => {
    const { impl, requests } = stubGeminiWire(SNAPSHOT_JSON);
    const provider = createGeminiLlmProvider({
      apiKey: 'AIza-1',
      model: 'gemini-4-argon',
      reasoningEffort: 'high',
      fetchImpl: impl,
    });
    await provider.expandSessionIntent('chill study music');
    expect(requests[0]?.body).toMatchObject({ model: 'gemini-4-argon', reasoning_effort: 'high' });
  });

  it('fails a refused call with a retryable error instead of passing the words through', async () => {
    const provider = createGeminiLlmProvider({
      apiKey: 'AIza-1',
      languageModel: throwingModel(Object.assign(new Error('quota'), { statusCode: 429 })),
    });
    await expect(provider.expandSessionIntent('chill study music')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('expandSessionIntent', () => {
  it.each([null, 12, 480, 601, 1.5])(
    'preserves duration metadata for creation-side validation: %s',
    async (minutes) => {
      const provider = createOpenAiLlmProvider({
        apiKey: 'test',
        languageModel: fakeModel([
          JSON.stringify({ ...JSON.parse(SNAPSHOT_JSON), requestedDurationMinutes: minutes }),
        ]),
      });
      const expanded = await provider.expandSessionIntentWithMetadata('music');
      expect(expanded.requestedDurationMinutes).toBe(minutes);
      expect(expanded.snapshot).not.toHaveProperty('requestedDurationMinutes');
    },
  );

  it('ignores duration extraction on Change Vibe', async () => {
    const captured: string[] = [];
    const provider = createOllamaLlmProvider({
      model: 'test',
      languageModel: promptCapturingModel(
        [JSON.stringify({ ...JSON.parse(SNAPSHOT_JSON), requestedDurationMinutes: 60 })],
        captured,
      ),
    });
    const expanded = await provider.expandSessionIntentWithMetadata(
      'one hour of warmer piano',
      null,
      undefined,
      {
        adjustFrom: compileStructuredControls({ mood: 'calm' }),
      },
    );
    expect(expanded.requestedDurationMinutes).toBeNull();
    expect(captured[0]).toContain('never extract a target from a change request or prompt history');
  });

  it('returns requested Session duration separately from the creative snapshot in one expansion', async () => {
    const captured: string[] = [];
    const provider = createOllamaLlmProvider({
      model: 'test',
      languageModel: promptCapturingModel(
        [JSON.stringify({ ...JSON.parse(SNAPSHOT_JSON), requestedDurationMinutes: 20 })],
        captured,
      ),
    });
    const expanded = await provider.expandSessionIntentWithMetadata('Zwanzig Minuten Meditation');
    expect(expanded.requestedDurationMinutes).toBe(20);
    expect(expanded.snapshot).not.toHaveProperty('requestedDurationMinutes');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('explicitly requested total Session duration');
  });

  it('parses a structured-output response into a Style Snapshot', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([SNAPSHOT_JSON]),
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.stylePrompt).toBe('mellow lofi beats');
    expect(snapshot.genreTags).toEqual(['lofi']);
    expect(snapshot.vocalMode).toBe('instrumental');
  });

  it('never lets the model set the Session Guardrails', async () => {
    // The guardrails are deterministic picks, not creative output: a model that
    // volunteers a maxed-out novelty would ship experimental music nobody asked for.
    const withGuardrails = JSON.stringify({
      stylePrompt: 'mellow lofi beats',
      styleStrength: 0.1,
      novelty: 1,
      userAvoid: 'piano',
    });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([withGuardrails]),
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.styleStrength).toBeUndefined();
    expect(snapshot.novelty).toBeUndefined();
    expect(snapshot.userAvoid).toBeUndefined();
  });

  it.each([true, false])(
    'never lets the model turn on Own Voice without the pick (structured=%s)',
    async (supportsStructuredOutputs) => {
      // A cloned-voice opt-in is user consent: a model that reads "in my voice"
      // into the field would sing with the user's voice (or block the Session).
      const reply = JSON.stringify({
        stylePrompt: 'synth-pop',
        vocalMode: 'vocal',
        language: 'English',
        useOwnVoice: true,
      });
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        supportsStructuredOutputs,
        languageModel: fakeModel([reply]),
      });
      const intent = 'a pop song sung in my own voice';
      const unpicked = await provider.expandSessionIntent(intent, null, { vocal: 'vocal' });
      expect(unpicked.useOwnVoice).toBe(false);
      const picked = await provider.expandSessionIntent(intent, null, {
        vocal: 'vocal',
        ownVoice: true,
      });
      expect(picked.useOwnVoice).toBe(true);
    },
  );

  it('preserves a model-provided frozen bpm/key', async () => {
    const withBpmKey = JSON.stringify({
      stylePrompt: 'mellow lofi beats',
      bpm: 96,
      key: 'D minor',
    });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([withBpmKey]),
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.bpm).toBe(96);
    expect(snapshot.key).toBe('D minor');
  });

  it('backfills a deterministic frozen bpm/key + seed when the model omits them', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([SNAPSHOT_JSON]), // no bpm/key/seedParameters
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    // Every session must be blend-ready, so the adapter freezes them.
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.bpm).toBeGreaterThan(0);
    expect(snapshot.key.length).toBeGreaterThan(0);
    expect(typeof snapshot.seedParameters.baseSeed).toBe('number');
  });

  it('adjustment holds the current frozen bpm/key when the model omits them', async () => {
    const current = compileStructuredControls({ genres: ['ambient'], energy: 'low' });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([SNAPSHOT_JSON]), // no bpm/key in the reply
    });
    const snapshot = await provider.expandSessionIntent('warmer, more acoustic', null, undefined, {
      adjustFrom: current,
    });
    expect(snapshot.bpm).toBe(current.bpm);
    expect(snapshot.key).toBe(current.key);
  });

  it('adjustment lets a model-provided bpm/key move the tempo', async () => {
    const current = compileStructuredControls({ genres: ['ambient'], energy: 'low' });
    const withBpmKey = JSON.stringify({
      stylePrompt: 'brisk lofi beats',
      bpm: 132,
      key: 'D minor',
    });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([withBpmKey]),
    });
    const snapshot = await provider.expandSessionIntent('much faster', null, undefined, {
      adjustFrom: current,
    });
    expect(snapshot.bpm).toBe(132);
    expect(snapshot.key).toBe('D minor');
  });

  it('adjustment re-freezes the tempo from an energy pick that changes the running energy, whether the model obeys or not', async () => {
    const current = compileStructuredControls({ genres: ['ambient'], energy: 'low' });
    const expand = (reply: Record<string, unknown>) =>
      createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        supportsStructuredOutputs: true,
        languageModel: fakeModel([
          JSON.stringify({ stylePrompt: 'ambient, high energy', ...reply }),
        ]),
      }).expandSessionIntent('', null, { energy: 'high' }, { adjustFrom: current });
    const obeyed = await expand({ energy: 'high', bpm: current.bpm });
    const ignored = await expand({ energy: 'low', bpm: current.bpm });
    expect(obeyed.bpm!).toBeGreaterThan(120);
    expect(obeyed.bpm).toBe(ignored.bpm);
  });

  it('adjustment keeps the running voice when the reply names none', async () => {
    const current = compileStructuredControls({ vocal: 'vocal', voice: 'female' });
    const expand = (reply: Record<string, unknown>) =>
      createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        supportsStructuredOutputs: true,
        languageModel: fakeModel([
          JSON.stringify({ stylePrompt: 'upbeat indie pop', language: 'English', ...reply }),
        ]),
      }).expandSessionIntent('a bit more upbeat', null, undefined, { adjustFrom: current });

    expect((await expand({ vocalMode: 'vocal' })).voiceGender).toBe('female');
    expect((await expand({ vocalMode: 'vocal', voiceGender: 'male' })).voiceGender).toBe('male');
    expect((await expand({ vocalMode: 'instrumental' })).voiceGender).toBe('');
  });

  it('sends the current snapshot and adjustment framing to the model', async () => {
    const captured: string[] = [];
    const current = compileStructuredControls({ genres: ['indie-pop'], language: 'German' });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: promptCapturingModel([SNAPSHOT_JSON], captured),
    });
    await provider.expandSessionIntent('a bit faster', null, undefined, { adjustFrom: current });
    expect(captured[0]).toContain('Change request');
    expect(captured[0]).toContain('indie-pop');
    expect(captured[0]).toContain('German');
  });

  it('parses JSON-in-text (markdown-fenced) when structured outputs are off', async () => {
    const fenced = '```json\n' + SNAPSHOT_JSON + '\n```';
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: false,
      languageModel: fakeModel([fenced]),
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.stylePrompt).toBe('mellow lofi beats');
  });

  it('runs one repair retry when the first response does not parse', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: false,
      languageModel: fakeModel(['not json at all', SNAPSHOT_JSON]),
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.stylePrompt).toBe('mellow lofi beats');
  });

  it('repairs once on the structured-output path too (schema-invalid then valid)', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      // First object omits the required stylePrompt → schema rejects → repair.
      languageModel: fakeModel(['{"mood":"calm"}', SNAPSHOT_JSON]),
    });
    const snapshot = await provider.expandSessionIntent('chill study music');
    expect(snapshot.stylePrompt).toBe('mellow lofi beats');
  });

  it('guides the expansion with explicit genre picks and enforces them over the model reply', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      // The model ignores the picks entirely — enforcement must not trust it.
      languageModel: promptCapturingModel([SNAPSHOT_JSON], captured),
    });
    const snapshot = await provider.expandSessionIntent('chill study music', null, {
      genres: ['techno', 'ambient'],
    });
    expect(captured[0]).toContain('techno');
    expect(captured[0]).toContain('ambient');
    expect(snapshot.genreTags).toEqual(['techno', 'ambient', 'lofi']);
    expect(snapshot.stylePrompt).toContain('techno');
    expect(snapshot.stylePrompt).toContain('ambient');
  });

  it('guides the expansion with energy/vocal/voice picks and enforces them over the model reply', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      // The model answers a calm instrumental snapshot; the second canned reply
      // serves the language backfill the FORCED vocal mode triggers.
      languageModel: promptCapturingModel([SNAPSHOT_JSON, 'English'], captured),
    });
    const snapshot = await provider.expandSessionIntent('chill study music', null, {
      energy: 'high',
      vocal: 'vocal',
      voice: 'female',
    });
    expect(captured[0]).toContain('energy to high');
    expect(captured[0]).toContain('wants vocals');
    expect(captured[0]).toContain('female singing voice');
    expect(snapshot.energy).toBe('high');
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.voiceGender).toBe('female');
    // The model's implied tempo is re-frozen from the forced energy.
    expect(snapshot.bpm!).toBeGreaterThan(120);
    // The forced-vocal session went through the language backfill.
    expect(snapshot.language).toBe('English');
  });

  it('a forced instrumental pick beats a vocal model reply without a language call', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: promptCapturingModel(
        [
          JSON.stringify({
            stylePrompt: 'dream pop with vocals',
            vocalMode: 'vocal',
            language: 'German',
          }),
        ],
        captured,
      ),
    });
    const snapshot = await provider.expandSessionIntent('dreamy singing', null, {
      vocal: 'instrumental',
    });
    expect(snapshot.vocalMode).toBe('instrumental');
    // An instrumental session keeps its detected language — it steers title
    // language; the vocal description tail is mode-gated regardless.
    expect(snapshot.language).toBe('German');
    expect(snapshot.negativeTerms).toContain('vocals');
    // Exactly one model call: no lyric/language follow-ups exist for instrumental.
    expect(captured).toHaveLength(1);
  });

  it('an explicit language pick is guided, enforced, and skips the detection follow-up', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      // The model answers a vocal snapshot in the WRONG language — enforcement
      // must not trust it, and no detection call may fire (the pick answers it).
      languageModel: promptCapturingModel(
        [
          JSON.stringify({
            stylePrompt: 'dream pop with vocals',
            vocalMode: 'vocal',
            language: 'Spanish',
          }),
        ],
        captured,
      ),
    });
    const snapshot = await provider.expandSessionIntent('dreamy singing', null, {
      language: 'German',
    });
    expect(captured[0]).toContain('German');
    expect(snapshot.language).toBe('German');
    expect(captured).toHaveLength(1);
  });

  it('an instrumental language pick rides the snapshot without a detection call', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: promptCapturingModel([SNAPSHOT_JSON], captured),
    });
    const snapshot = await provider.expandSessionIntent('chill study music', null, {
      language: 'Japanese',
    });
    expect(snapshot.vocalMode).toBe('instrumental');
    expect(snapshot.language).toBe('Japanese');
    expect(captured).toHaveLength(1);
  });

  it("keeps the text AI's style as written, with no phrase filtered out", async () => {
    const style = JSON.stringify({
      stylePrompt: 'groovy disco loops in the style of French house',
    });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: fakeModel([style]),
    });
    const snapshot = await provider.expandSessionIntent('french house for a sunny drive');
    expect(snapshot.stylePrompt).toContain('in the style of French house');
    expect(snapshot.safetyWarnings).toEqual([]);
  });

  it('throws a sanitized ProviderError when even the repair fails', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: false,
      languageModel: fakeModel(['garbage', 'still garbage']),
    });
    await expect(provider.expandSessionIntent('x')).rejects.toBeInstanceOf(ProviderError);
  });

  it('marks an unparseable double-reply as such in safeDetail (diagnosable config smell)', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: false,
      languageModel: fakeModel(['garbage', 'still garbage']),
    });
    const err = (await provider.expandSessionIntent('x').catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.safeDetail).toEqual({ failure: 'unparseable_response' });
  });

  it('carries the SDK error name/status in safeDetail — never its message/body', async () => {
    const apiError = Object.assign(new Error('401 {"error":"raw body with sk-secret-key"}'), {
      name: 'AI_APICallError',
      statusCode: 401,
    });
    for (const supportsStructuredOutputs of [false, true]) {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        supportsStructuredOutputs,
        languageModel: throwingModel(apiError),
      });
      const err = (await provider
        .expandSessionIntent('x')
        .catch((e: unknown) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.safeDetail?.errorName).toBe('AI_APICallError');
      expect(err.safeDetail?.statusCode).toBe(401);
      // The raw provider body/message must never travel on the sanitized error.
      expect(JSON.stringify({ message: err.message, detail: err.safeDetail })).not.toContain(
        'sk-secret-key',
      );
    }
  });

  it('surfaces a timeout with its own retry message — not "check the configuration"', async () => {
    // What `AbortSignal.timeout` raises when a slow (reasoning) model overruns
    // the per-call budget: a DOMException named TimeoutError.
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    for (const supportsStructuredOutputs of [false, true]) {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        supportsStructuredOutputs,
        languageModel: throwingModel(timeoutError as unknown as Error),
      });
      const err = (await provider
        .expandSessionIntent('x')
        .catch((e: unknown) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain('took too long');
      expect(err.message).not.toContain('configuration');
      expect(err.safeDetail?.timedOut).toBe(true);
    }
  });

  it('sends a failed structured call once: only an unparseable answer earns the repair', async () => {
    const timeoutError = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    const model = throwingModel(timeoutError as unknown as Error) as unknown as {
      doGenerate: () => Promise<never>;
    };
    const doGenerate = vi.spyOn(model, 'doGenerate');
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      languageModel: model as unknown as LanguageModel,
    });
    const err = (await provider.expandSessionIntent('x').catch((e: unknown) => e)) as ProviderError;
    expect(err.message).toContain('took too long');
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it('stops the model call when the caller gives up', async () => {
    const hanging = {
      specificationVersion: 'v4',
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {},
      doGenerate: ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) => {
          if (abortSignal?.aborted) reject(abortSignal.reason);
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
        }),
      async doStream() {
        throw new Error('streaming not used');
      },
    } as unknown as LanguageModel;
    for (const supportsStructuredOutputs of [false, true]) {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        supportsStructuredOutputs,
        languageModel: hanging,
      });
      const caller = new AbortController();
      const expanding = provider.expandSessionIntent('x', null, undefined, {
        signal: caller.signal,
      });
      caller.abort();
      await expect(expanding).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it('refuses to reach a private generation host before any model call', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs: true,
      baseUrl: 'http://10.0.0.5/v1',
      // Injected model would throw if called; the SSRF guard must trip first.
      languageModel: fakeModel([SNAPSHOT_JSON]),
    });
    await expect(provider.expandSessionIntent('x')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('createTrackMetadata (non-blocking, never throws)', () => {
  it('uses the model output when it is usable', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel([JSON.stringify({ title: 'Night Drift', artistName: 'Neon Tide' })]),
    });
    const meta = await provider.createTrackMetadata({
      stylePrompt: 'lofi',
      negativeTerms: [],
      mood: '',
      activity: 'studying',
      genreTags: ['lofi'],
      vocalMode: 'instrumental',
      energy: 'medium',
      titleScheme: 'studying',
      title: '',
      trackTitles: [],
      lyricContext: '',
      language: '',
      voiceGender: '',
      useOwnVoice: false,
      safetyWarnings: [],
      bpm: 90,
      key: 'A minor',
      seedParameters: { baseSeed: 1, rerollSalt: 0 },
    });
    expect(meta.title).toBe('Night Drift');
    expect(meta.artistName).toBe('Neon Tide');
  });

  it('falls back to deterministic metadata when the model output is unusable', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel(['not json']),
    });
    const snapshot = {
      stylePrompt: 'lofi',
      negativeTerms: [],
      mood: '',
      activity: 'studying',
      genreTags: ['lofi'],
      vocalMode: 'instrumental' as const,
      energy: 'medium' as const,
      titleScheme: 'studying',
      title: '',
      trackTitles: [],
      lyricContext: '',
      language: '',
      voiceGender: '' as const,
      useOwnVoice: false,
      safetyWarnings: [],
      bpm: 90,
      key: 'A minor',
      seedParameters: { baseSeed: 1, rerollSalt: 0 },
    };
    const meta = await provider.createTrackMetadata(snapshot);
    expect(meta.title.length).toBeGreaterThan(0);
    expect(meta.artistName.length).toBeGreaterThan(0);
  });

  it('falls back deterministically (never throws) when the base URL is blocked', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      baseUrl: 'http://169.254.169.254/v1',
      languageModel: fakeModel(['{"title":"X","artistName":"Y"}']),
    });
    const snapshot = compileStructuredControls({ activity: 'studying', genres: ['lofi'] });
    const meta = await provider.createTrackMetadata(snapshot, 2);
    // The SSRF guard trips, so we get the deterministic derivation, not "X"/"Y".
    expect(meta.title).not.toBe('X');
    expect(meta.title.length).toBeGreaterThan(0);
  });
});

describe('clampMaxRetries', () => {
  it('clamps a misconfigured retry count to a small ceiling (no runaway spend)', () => {
    expect(clampMaxRetries(100)).toBe(3);
    expect(clampMaxRetries(-5)).toBe(0);
    expect(clampMaxRetries(undefined)).toBe(1); // default
    expect(clampMaxRetries(2)).toBe(2);
    // NaN / non-integer must be coerced — the AI SDK rejects a non-integer.
    expect(clampMaxRetries(Number.NaN)).toBe(1);
    expect(clampMaxRetries(2.7)).toBe(2);
    expect(clampMaxRetries(Number.POSITIVE_INFINITY)).toBe(3);
  });
});

describe('getCapabilities', () => {
  it('reports the model and structured-output support', () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'anthropic/claude-3.5',
      supportsStructuredOutputs: true,
    });
    expect(provider.providerType).toBe('llm');
    expect(provider.providerKey).toBe('openrouter');
    expect(provider.getCapabilities()).toEqual({
      supportsStructuredOutputs: true,
      model: 'anthropic/claude-3.5',
    });
  });
});

describe('createSessionMetadata (never throws, empty on failure)', () => {
  const snapshot = compileStructuredControls({ activity: 'reading', genres: ['ambient'] });

  it('returns the model naming, trimmed, with blank pool entries dropped', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel([
        JSON.stringify({
          title: '  Rainy Reading  ',
          trackTitles: ['Umbrella Steps', '  Window Fog ', ''],
        }),
      ]),
    });
    const naming = await provider.createSessionMetadata({ userPrompt: null, snapshot });
    expect(naming).toEqual({
      title: 'Rainy Reading',
      trackTitles: ['Umbrella Steps', 'Window Fog'],
      lyricContext: '',
      coverConcept: '',
      autoCoverStyle: null,
    });
  });

  it('returns empty metadata on an unusable reply (the consumer derives the Name)', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel(['not json at all']),
    });
    const naming = await provider.createSessionMetadata({
      userPrompt: 'ambient for reading',
      snapshot,
    });
    expect(naming).toEqual({
      title: '',
      trackTitles: [],
      lyricContext: '',
      coverConcept: '',
      autoCoverStyle: null,
    });
  });

  it('returns empty metadata (never throws) when the base URL is blocked by the SSRF guard', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      baseUrl: 'http://169.254.169.254/v1',
      languageModel: fakeModel(['{"title":"X","trackTitles":["Y"]}']),
    });
    const naming = await provider.createSessionMetadata({ userPrompt: null, snapshot });
    expect(naming).toEqual({
      title: '',
      trackTitles: [],
      lyricContext: '',
      coverConcept: '',
      autoCoverStyle: null,
    });
  });
});

describe('expandSessionIntent carries creative naming when the model provides it', () => {
  it('keeps title and trackTitles from the expansion response', async () => {
    const withNaming = JSON.stringify({
      stylePrompt: 'mellow lofi beats',
      title: 'Midnight Pages',
      trackTitles: ['Amber Rain', 'Night Signal'],
    });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel([withNaming]),
    });
    const snapshot = await provider.expandSessionIntent('lofi for late reading');
    expect(snapshot.title).toBe('Midnight Pages');
    expect(snapshot.trackTitles).toEqual(['Amber Rain', 'Night Signal']);
  });
});

describe('listener-profile personalization (LLM-gated)', () => {
  const LISTENER = {
    name: 'John',
    city: 'Riverton',
    people: [{ name: 'John', about: 'trail runs with the kids' }],
  };
  const VOCAL_JSON = JSON.stringify({
    stylePrompt: 'upbeat acoustic pop',
    vocalMode: 'vocal',
    lyricContext: 'trail runs with the kids',
  });

  function providerWith(texts: string[], captured: string[]) {
    return createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(texts, captured),
    });
  }

  it('sends the profile and request-led relevance rule with the expansion', async () => {
    const captured: string[] = [];
    await providerWith([VOCAL_JSON], captured).expandSessionIntent(
      'a song about our weekend runs',
      LISTENER,
    );
    expect(captured[0]).toContain('Listener profile');
    expect(captured[0]).toContain('name: John');
    expect(captured[0]).toContain('city: Riverton');
    expect(captured[0]).toContain('do not try to maximize profile coverage');
  });

  it('asks for compact labeled lyric notes from a few developed request-relevant details', async () => {
    const captured: string[] = [];
    await providerWith([VOCAL_JSON], captured).expandSessionIntent(
      'an uplifting folk song about a parent and child crossing a mountain pass',
      {
        name: 'John',
        people: [
          {
            name: 'Tina',
            about:
              'I take mountain rides with John, design board games, and keep a rooftop garden.',
          },
        ],
      },
    );

    expect(captured[0]).toContain('The listening request is the primary creative direction');
    expect(captured[0]).toMatch(/DEVELOP them into one scene or story/);
    expect(captured[0]).toContain('in a verse line in SOME tracks');
    expect(captured[0]).toContain(
      'never soften, moralize, or invert it into a lesson, redemption arc, or its opposite',
    );
    expect(captured[0]).toContain(
      'Write lyricContext as compact, labeled creative notes instead of prose sentences',
    );
    expect(captured[0]).toContain('Use semicolons between categories and commas within categories');
    expect(captured[0]).toContain(
      'central theme, story moments, imagery, emotional arc, people/relationships, setting',
    );
    expect(captured[0]).toContain(
      'Do not produce a biography, resume, or unstructured inventory of profile facts',
    );
    expect(captured[0]).toContain(
      'theme: strain turning to pride; scene: rainy mountain climb, jokes on steep turns',
    );
  });

  it('keeps an un-personalized expansion prompt profile-free', async () => {
    const captured: string[] = [];
    await providerWith([SNAPSHOT_JSON], captured).expandSessionIntent('rainy night drive');
    expect(captured[0]).not.toContain('Listener profile');
  });

  it('keeps the selected lyricContext on a vocal expansion with a profile', async () => {
    const snapshot = await providerWith([VOCAL_JSON], []).expandSessionIntent('sing it', LISTENER);
    expect(snapshot.lyricContext).toBe('trail runs with the kids');
  });

  it('preserves compact lyric notes long enough to carry detailed personal material', async () => {
    const lyricContext =
      'people: John + Tina, parent/child, teasing each other on climbs; setting: mountain rain, steep Alpine pass; moments: shared jokes, Tina sets the pace; imagery: spinning wheels, distant bells, thin air; arc: strain to pride to freedom';
    const reply = JSON.stringify({
      stylePrompt: 'uplifting acoustic folk for a mountain journey',
      vocalMode: 'vocal',
      lyricContext,
    });

    const snapshot = await providerWith([reply], []).expandSessionIntent(
      'an uplifting folk song about a parent and child crossing a mountain pass',
      {
        name: 'John',
        people: [{ name: 'Tina', about: 'I ride mountain passes with John.' }],
      },
    );

    expect(snapshot.lyricContext).toBe(lyricContext);
  });

  it('clears a lyricContext the model invented WITHOUT a profile', async () => {
    const snapshot = await providerWith([VOCAL_JSON], []).expandSessionIntent('sing it');
    expect(snapshot.lyricContext).toBe('');
  });

  it('keeps a request-derived lyricContext on a vocal skip-profile expansion', async () => {
    const captured: string[] = [];
    const snapshot = await providerWith([VOCAL_JSON], captured).expandSessionIntent(
      'sing about Mia dancing in the rain',
      null,
      undefined,
      { skipProfile: true },
    );
    expect(snapshot.lyricContext).toBe('trail runs with the kids');
    expect(captured[0]).toContain('the request itself provides');
  });

  it('ignores a supplied listener profile when the session skips the profile', async () => {
    const captured: string[] = [];
    await providerWith([VOCAL_JSON], captured).expandSessionIntent('sing it', LISTENER, undefined, {
      skipProfile: true,
    });
    expect(captured[0]).not.toContain('Listener profile');
    expect(captured[0]).not.toContain('Riverton');
  });

  it('clears lyricContext on an instrumental expansion even with a profile', async () => {
    const instrumental = JSON.stringify({
      stylePrompt: 'calm piano',
      vocalMode: 'instrumental',
      lyricContext: 'trail runs with the kids',
    });
    const snapshot = await providerWith([instrumental], []).expandSessionIntent('calm', LISTENER);
    expect(snapshot.lyricContext).toBe('');
  });

  it('scopes matched People to lyricContext and keeps their About out of naming instructions', async () => {
    const captured: string[] = [];
    await providerWith([VOCAL_JSON], captured).expandSessionIntent('sing about Julia', {
      people: [{ name: 'Julia', about: 'restores old bicycles beside the river' }],
    });
    expect(captured[0]).toContain('Julia');
    expect(captured[0]).toContain('restores old bicycles beside the river');
    expect(captured[0]).toContain('use only for lyricContext');
    expect(captured[0]).toMatch(/must not affect.*title.*trackTitles.*coverConcept/i);
  });

  it('never sends Person About through the structured/naming seam', async () => {
    const captured: string[] = [];
    const vocalSnapshot = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });
    await providerWith(
      [JSON.stringify({ title: 'Safe title', trackTitles: ['One'], lyricContext: 'invented' })],
      captured,
    ).createSessionMetadata({
      userPrompt: null,
      snapshot: vocalSnapshot,
      listener: { people: [{ name: 'Julia', about: 'PRIVATE_PERSON_ABOUT' }] },
    });
    expect(captured[0]).not.toContain('PRIVATE_PERSON_ABOUT');
    expect(captured[0]).not.toContain('Julia');
  });

  it('naming on a vocal session asks for lyricContext and returns it trimmed', async () => {
    const captured: string[] = [];
    const vocalSnapshot = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });
    const naming = await providerWith(
      [
        JSON.stringify({
          title: 'Trail Songs',
          trackTitles: ['A'],
          lyricContext: '  kids on trails ',
        }),
      ],
      captured,
    ).createSessionMetadata({ userPrompt: null, snapshot: vocalSnapshot, listener: LISTENER });
    expect(captured[0]).toContain(String.raw`\"lyricContext\": string`);
    expect(naming.lyricContext).toBe('kids on trails');
  });

  it('naming on an instrumental session never asks for lyricContext', async () => {
    const captured: string[] = [];
    const instrumental = compileStructuredControls({ genres: ['ambient'] });
    await providerWith(
      [JSON.stringify({ title: 'Still Air', trackTitles: ['A'] })],
      captured,
    ).createSessionMetadata({ userPrompt: null, snapshot: instrumental, listener: LISTENER });
    expect(captured[0]).not.toContain(String.raw`\"lyricContext\": string`);
  });
});

describe('a request that includes the listener', () => {
  const reply = (includesListener?: boolean) =>
    JSON.stringify({
      stylePrompt: 'bright synth-pop',
      vocalMode: 'vocal',
      lyricContext: 'theme: moon trip; people: Emma + Jonas',
      ...(includesListener === undefined ? {} : { includesListener }),
    });

  function providerWith(texts: string[], captured: string[] = []) {
    return createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(texts, captured),
    });
  }

  it('reports the model’s answer on whether the request includes the listener', async () => {
    const included = await providerWith([reply(true)]).expandSessionIntentWithMetadata(
      'Me and Jonas on a trip to the moon',
    );
    const left = await providerWith([reply(false)]).expandSessionIntentWithMetadata('for Jonas');
    expect(included.includesListener).toBe(true);
    expect(left.includesListener).toBe(false);
  });

  it('reports no answer when the model gives none', async () => {
    const silent = await providerWith([reply()]).expandSessionIntentWithMetadata('for Jonas');
    expect(silent.includesListener).toBeUndefined();
  });
});

describe('the Auto cover style pick', () => {
  function providerWith(texts: string[], supportsStructuredOutputs: boolean, captured?: string[]) {
    return createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      supportsStructuredOutputs,
      languageModel: promptCapturingModel(texts, captured ?? []),
    });
  }
  const expansion = (coverStyle?: unknown) =>
    JSON.stringify({
      stylePrompt: 'mellow lofi beats',
      coverConcept: 'One lamp over an open notebook.',
      ...(coverStyle === undefined ? {} : { coverStyle }),
    });
  const naming = (coverStyle?: unknown) =>
    JSON.stringify({
      title: 'Midnight Pages',
      trackTitles: ['Amber Rain'],
      coverConcept: 'One lamp over an open notebook.',
      ...(coverStyle === undefined ? {} : { coverStyle }),
    });
  const snapshot = compileStructuredControls({ activity: 'reading', genres: ['lofi'] });

  describe.each([
    ['structured output', true],
    ['JSON in text', false],
  ])('on the %s path', (_path, structured) => {
    it('an expansion keeps a valid pick', async () => {
      const expanded = await providerWith(
        [expansion('photographic')],
        structured,
      ).expandSessionIntentWithMetadata('lofi for late reading');
      expect(expanded.autoCoverStyle).toBe('photographic');
    });

    it('a naming reply keeps a valid pick', async () => {
      const named = await providerWith([naming('photographic')], structured).createSessionMetadata({
        userPrompt: null,
        snapshot,
      });
      expect(named.autoCoverStyle).toBe('photographic');
    });

    it.each([
      ['Record Sleeve', 'record_sleeve'],
      ['poster-art', 'poster_art'],
      [' MANGA ', 'manga'],
    ])('reads a pick of %s, spelled loosely, as its preset', async (coverStyle, preset) => {
      const expanded = await providerWith(
        [expansion(coverStyle)],
        structured,
      ).expandSessionIntentWithMetadata('lofi for late reading');
      expect(expanded.autoCoverStyle).toBe(preset);
      const named = await providerWith([naming(coverStyle)], structured).createSessionMetadata({
        userPrompt: null,
        snapshot,
      });
      expect(named.autoCoverStyle).toBe(preset);
    });

    it.each([['watercolor'], ['auto'], [undefined]])(
      'an answer of %s is no pick, and the reply still counts',
      async (coverStyle) => {
        const expanded = await providerWith(
          [expansion(coverStyle)],
          structured,
        ).expandSessionIntentWithMetadata('lofi for late reading');
        expect(expanded.autoCoverStyle).toBeNull();
        expect(expanded.coverConcept).toBe('One lamp over an open notebook.');
        const named = await providerWith([naming(coverStyle)], structured).createSessionMetadata({
          userPrompt: null,
          snapshot,
        });
        expect(named.autoCoverStyle).toBeNull();
        expect(named.title).toBe('Midnight Pages');
      },
    );
  });

  it('both prompts ask for one of the six presets, each described', async () => {
    const captured: string[] = [];
    await providerWith([expansion('manga')], false, captured).expandSessionIntentWithMetadata(
      'lofi for late reading',
    );
    await providerWith([naming('manga')], false, captured).createSessionMetadata({
      userPrompt: null,
      snapshot,
    });
    for (const prompt of captured) {
      expect(prompt).toContain('coverStyle');
      for (const preset of [
        'record_sleeve',
        'poster_art',
        'photographic',
        'manga',
        'drawing',
        'minimal',
      ]) {
        expect(prompt).toMatch(new RegExp(`${preset}[^,;]*:`));
      }
    }
  });

  it('a failed naming call has no pick', async () => {
    const named = await providerWith(['not json at all'], false).createSessionMetadata({
      userPrompt: null,
      snapshot,
    });
    expect(named.autoCoverStyle).toBeNull();
  });
});

describe('createSessionMetadata enforces the lyric-context rule on its output', () => {
  const reply = JSON.stringify({ title: 'T', trackTitles: ['A'], lyricContext: 'made up' });
  const LISTENER = { name: 'John' };

  function provider() {
    return createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel([reply]),
    });
  }

  it('clears a lyricContext invented without a profile', async () => {
    const vocal = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });
    const naming = await provider().createSessionMetadata({ userPrompt: null, snapshot: vocal });
    expect(naming.lyricContext).toBe('');
  });

  it('clears a lyricContext invented for an instrumental session', async () => {
    const instrumental = compileStructuredControls({ genres: ['ambient'] });
    const naming = await provider().createSessionMetadata({
      userPrompt: null,
      snapshot: instrumental,
      listener: LISTENER,
    });
    expect(naming.lyricContext).toBe('');
  });
});

describe('request-language rule (German request → German titles and vocals)', () => {
  const GERMAN_VOCAL_JSON = JSON.stringify({
    stylePrompt: 'upbeat acoustic pop',
    vocalMode: 'vocal',
    title: 'Lieder für unterwegs',
    language: 'German',
  });

  it('instructs the expansion to match the request language and carries the detected language', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel([GERMAN_VOCAL_JSON], captured),
    });
    const snapshot = await provider.expandSessionIntent('ein Lied über unsere Wochenendläufe');
    expect(captured[0]).toContain('SAME language as the request');
    expect(snapshot.language).toBe('German');
    expect(snapshot.title).toBe('Lieder für unterwegs');
  });

  it('adds the language rule to naming ONLY when a listening request exists to read it from', async () => {
    const snapshot = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });
    const reply = JSON.stringify({ title: 'T', trackTitles: ['A'] });

    const withPrompt: string[] = [];
    await createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel([reply], withPrompt),
    }).createSessionMetadata({ userPrompt: 'ein Lied für den Abend', snapshot });
    expect(withPrompt[0]).toContain('SAME language as the request');

    const withoutPrompt: string[] = [];
    await createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel([reply], withoutPrompt),
    }).createSessionMetadata({ userPrompt: null, snapshot });
    expect(withoutPrompt[0]).not.toContain('SAME language as the request');
  });
});

describe('vocal language fallback (expansion omitted or junked the language)', () => {
  it('asks no language question about a picks-only change, which has no message to read', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(
        [JSON.stringify({ stylePrompt: 'acoustic pop', vocalMode: 'vocal' }), '"German".'],
        captured,
      ),
    });
    const adjustFrom = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });
    const snapshot = await provider.expandSessionIntent(
      '',
      null,
      { energy: 'high' },
      { adjustFrom },
    );
    expect(captured).toHaveLength(1);
    expect(snapshot.language).toBe('');
  });

  it('asks one follow-up question when a vocal expansion omits language', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(
        [JSON.stringify({ stylePrompt: 'acoustic pop', vocalMode: 'vocal' }), '"German".'],
        captured,
      ),
    });
    const snapshot = await provider.expandSessionIntent('ein Lied über den Sommer');
    expect(captured).toHaveLength(2);
    expect(captured[1]).toContain('What language is this request written in?');
    expect(snapshot.language).toBe('German');
  });

  it('backfills after sanitization drops an injected language value', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(
        [
          JSON.stringify({
            stylePrompt: 'acoustic pop',
            vocalMode: 'vocal',
            language: 'German, exactly like Adele',
          }),
          'German',
        ],
        [],
      ),
    });
    const snapshot = await provider.expandSessionIntent('ein Lied über den Sommer');
    expect(snapshot.language).toBe('German');
  });

  it('never asks for an instrumental expansion and never throws on a failed follow-up', async () => {
    const instrumentalCaptured: string[] = [];
    const instrumental = await createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel([SNAPSHOT_JSON], instrumentalCaptured),
    }).expandSessionIntent('rainy night drive');
    expect(instrumentalCaptured).toHaveLength(1);
    expect(instrumental.language).toBe('');

    // A language the model volunteers on an instrumental snapshot is kept —
    // it steers title language; the vocal tail is mode-gated regardless.
    const volunteered = await createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel([
        JSON.stringify({
          stylePrompt: 'calm piano',
          vocalMode: 'instrumental',
          language: 'German',
        }),
      ]),
    }).expandSessionIntent('ruhiges Klavier');
    expect(volunteered.language).toBe('German');

    // Vocal expansion succeeds, then the follow-up reply is junk → '' (no tag).
    const snapshot = await createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel([
        JSON.stringify({ stylePrompt: 'pop', vocalMode: 'vocal' }),
        'not; a! language?',
      ]),
    }).expandSessionIntent('sing something');
    expect(snapshot.language).toBe('');
  });
});

describe('enhanceCoverDirection', () => {
  it('rewrites the direction via one bounded call carrying only safe context', async () => {
    const captured: string[] = [];
    const provider = createOpenAiLlmProvider({
      apiKey: 'k',
      languageModel: promptCapturingModel(
        ['a serene paper skyline at dusk, warm rim light, muted amber palette'],
        captured,
      ),
    });
    const result = await provider.enhanceCoverDirection({
      text: 'warm dusk skyline',
      context: { sessionName: 'Rain Session', style: 'minimal', mood: 'calm', genres: ['ambient'] },
    });
    expect(result).toEqual({
      text: 'a serene paper skyline at dusk, warm rim light, muted amber palette',
      applied: true,
    });
    expect(captured[0]).toContain('warm dusk skyline');
    expect(captured[0]).toContain('Rain Session');
    expect(captured[0]).toContain('minimal');
  });

  it('tells the rewrite to describe named references visually and keep ordinary words', async () => {
    const captured: string[] = [];
    const provider = createOpenAiLlmProvider({
      apiKey: 'k',
      languageModel: promptCapturingModel(['a red apple on a harbor wall'], captured),
    });
    await provider.enhanceCoverDirection({ text: 'one red apple by the sea', context: {} });
    expect(captured[0]).toMatch(
      /names an artist, studio, franchise, or brand as a reference, describe its visual qualities in your own words/i,
    );
    expect(captured[0]).toMatch(/never write the name/i);
    expect(captured[0]).toMatch(/in any language/i);
    expect(captured[0]).toMatch(/ordinary words keep their ordinary meaning/i);
  });

  it('falls back to the raw text without throwing when the model call fails', async () => {
    const provider = createOpenAiLlmProvider({
      apiKey: 'k',
      languageModel: throwingModel(new Error('provider exploded')),
    });
    await expect(
      provider.enhanceCoverDirection({ text: 'warm dusk skyline', context: {} }),
    ).resolves.toEqual({ text: 'warm dusk skyline', applied: false });
  });

  it('treats an empty rewrite as not applied', async () => {
    const provider = createOpenAiLlmProvider({
      apiKey: 'k',
      languageModel: promptCapturingModel(['   '], []),
    });
    await expect(
      provider.enhanceCoverDirection({ text: 'warm dusk skyline', context: {} }),
    ).resolves.toEqual({ text: 'warm dusk skyline', applied: false });
  });
});

describe('createTrackLyricBrief (best-effort, never throws)', () => {
  const input = {
    lyricContext: 'theme: night rides; people: Mia',
    language: 'German',
    stylePrompt: 'mellow indie pop',
    mood: 'wistful',
    previousBriefs: ['scene: harbor at dawn'],
  };

  it('returns the model reply trimmed on the happy path', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(['  scene: last tram home, empty seats  '], captured),
    });
    await expect(provider.createTrackLyricBrief(input)).resolves.toBe(
      'scene: last tram home, empty seats',
    );
    expect(captured[0]).toContain('scene: harbor at dawn');
    expect(captured[0]).toContain('Write the brief in German.');
  });

  it("runs on the adapter's configured request timeout, not a tighter cap", async () => {
    // The budget seam is the AbortSignal the call is bounded by; a per-call
    // override below the configured timeout would surface here as a smaller
    // timeout value.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        requestTimeoutMs: 25_000,
        languageModel: fakeModel(['scene: night market, paper lanterns']),
      });
      await provider.createTrackLyricBrief(input);
      expect(timeoutSpy).toHaveBeenCalledWith(25_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('clamps an overlong reply to 200 chars', async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: fakeModel(['x'.repeat(500)]),
    });
    await expect(provider.createTrackLyricBrief(input)).resolves.toBe('x'.repeat(200));
  });

  it("returns '' on a timeout or transport failure — no raw provider error escapes", async () => {
    const errors = [
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ) as unknown as Error,
      Object.assign(new Error('401 {"error":"raw body with sk-secret-key"}'), {
        name: 'AI_APICallError',
        statusCode: 401,
      }),
    ];
    for (const error of errors) {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        languageModel: throwingModel(error),
      });
      await expect(provider.createTrackLyricBrief(input)).resolves.toBe('');
    }
  });

  it("returns '' (never throws) when the base URL is blocked by the SSRF guard", async () => {
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      baseUrl: 'http://169.254.169.254/v1',
      languageModel: fakeModel(['scene: would leak']),
    });
    await expect(provider.createTrackLyricBrief(input)).resolves.toBe('');
  });
});

describe('createTrackTitles (best-effort, never throws)', () => {
  const input = {
    takenTitles: ['Neon Harbor', 'Paper Moons'],
    count: 3,
    stylePrompt: 'mellow synthwave',
    mood: 'nostalgic',
    language: 'German',
    userPrompt: 'night drive',
  };

  it('returns the proposed titles clamped and capitalized, capped at count', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(
        [
          JSON.stringify({
            trackTitles: [' ', 'glass avenue', 'Velvet Static', 'Late Signal', 'One Too Many'],
          }),
        ],
        captured,
      ),
    });
    await expect(provider.createTrackTitles(input)).resolves.toEqual([
      'Glass Avenue',
      'Velvet Static',
      'Late Signal',
    ]);
    expect(captured[0]).toContain('Neon Harbor; Paper Moons');
    expect(captured[0]).toContain('in German');
  });

  it('returns [] on an unusable reply or a transport failure — no raw provider error escapes', async () => {
    const models = [
      fakeModel(['not json at all']),
      throwingModel(Object.assign(new Error('401 raw body with sk-secret'), { statusCode: 401 })),
    ];
    for (const languageModel of models) {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        languageModel,
      });
      await expect(provider.createTrackTitles(input)).resolves.toEqual([]);
    }
  });
});

describe('createSurpriseRequest (Surprise Me writes a fresh request)', () => {
  const input = {
    subject: 'a morning moment: waking up, first coffee, the commute, early light',
    music: 'Lo-fi and Deep House, instrumental',
    examples: ['Slow Sunday cooking, about two hours, nowhere to be…'],
    place: 'Hamburg, Germany',
    avoid: 'First coffee in Hamburg, the kitchen still quiet — Lo-fi, instrumental.',
  };

  it('returns the written request with an energy and a 10–60 minute length', async () => {
    const captured: string[] = [];
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel(
        [
          JSON.stringify({
            request: '  Fog lifting off the Elbe while the ferry warms up — dusty Lo-fi.  ',
            energy: 'low',
            durationMinutes: 47,
          }),
        ],
        captured,
      ),
    });
    await expect(provider.createSurpriseRequest(input)).resolves.toEqual({
      request: 'Fog lifting off the Elbe while the ferry warms up — dusty Lo-fi.',
      energy: 'low',
      durationMinutes: 45,
    });
    for (const part of [input.subject, input.music, input.examples[0]!, input.avoid, 'Hamburg'])
      expect(captured[0]).toContain(part);
  });

  it('writes the request in the Session language, so title and vocals follow it', async () => {
    const captured: string[] = [];
    const reply = JSON.stringify({
      request: 'Nebel über der Elbe.',
      energy: 'low',
      durationMinutes: 30,
    });
    const provider = createOpenRouterLlmProvider({
      apiKey: 'sk-or-1',
      model: 'm',
      languageModel: promptCapturingModel([reply, reply], captured),
    });
    await provider.createSurpriseRequest({ ...input, language: 'German' });
    await provider.createSurpriseRequest(input);
    expect(captured[0]).toContain('in German');
    expect(captured[0]).not.toContain('in English');
    expect(captured[1]).toContain('in English');
  });

  it('an unusable reply or a transport failure is a sanitized, retryable ProviderError', async () => {
    const models = [
      fakeModel(['not json at all']),
      throwingModel(Object.assign(new Error('401 raw body with sk-secret'), { statusCode: 401 })),
    ];
    for (const languageModel of models) {
      const provider = createOpenRouterLlmProvider({
        apiKey: 'sk-or-1',
        model: 'm',
        languageModel,
      });
      const failure = await provider.createSurpriseRequest(input).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as Error).message).not.toContain('sk-secret');
    }
  });
});
