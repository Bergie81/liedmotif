import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sunoMusicProvider } from './suno';
import { ProviderError, ProviderUnbilledError } from '../errors';
import {
  creditSuccess,
  recordInfoCallbackException,
  recordInfoCreateTaskFailed,
  recordInfoErrorFieldGenerateFailed,
  recordInfoErrorFieldInsufficientCredit,
  recordInfoFirstSuccess,
  recordInfoGenerateFailed,
  recordInfoInsufficientCredit,
  recordInfoMissingData,
  recordInfoMissingStatus,
  recordInfoPending,
  recordInfoSensitiveWord,
  recordInfoSuccess,
  recordInfoSuccessEmptyError,
  recordInfoTextSuccess,
  recordInfoUnknownFailure,
  submitErrorCode,
  submitMissingTaskId,
  submitSuccess,
  SUNO_TASK_ID,
  finalVocalTrack,
  timestampedLyricsErrorCode,
  timestampedLyricsSuccess,
  timestampedLyricsUnavailable,
  VOCAL_LYRICS,
  GENERATED_LYRICS,
  lyricsRecordInfoFailed,
  lyricsRecordInfoPending,
  lyricsRecordInfoSuccess,
  lyricsSubmitSuccess,
  PROVIDER_VOICE_ID,
} from './suno.fixtures';
import type { MusicGenerationInput } from './index';

const API_KEY = 'suno-secret-key-do-not-leak';
const BASE_URL = 'https://api.test.invalid';
const CALLBACK_URL = 'https://callback.test.invalid/configured';

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/**
 * An injected `fetch` stub. It records every call and routes by pathname to a
 * fixed response — an UNEXPECTED path throws, so a test fails loudly if the
 * adapter ever calls an endpoint we did not stub (proving the request set).
 */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes[parsed.pathname];
    if (!route) throw new Error(`unexpected fetch to ${parsed.pathname}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const GENERATE_PATH = '/api/v1/generate';
const RECORD_INFO_PATH = '/api/v1/generate/record-info';
const CREDIT_PATH = '/api/v1/generate/credit';
const TIMESTAMPED_LYRICS_PATH = '/api/v1/generate/get-timestamped-lyrics';
const LYRICS_PATH = '/api/v1/lyrics';
const LYRICS_RECORD_INFO_PATH = '/api/v1/lyrics/record-info';

function makeProvider(fetchImpl: typeof fetch) {
  return sunoMusicProvider({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    callbackUrl: CALLBACK_URL,
    fetch: fetchImpl,
  });
}

const NON_CUSTOM_INPUT: MusicGenerationInput = {
  mode: 'non_custom',
  prompt: 'A calm lo-fi instrumental study beat',
  instrumental: true,
};

const CUSTOM_INPUT: MusicGenerationInput = {
  mode: 'custom',
  prompt: 'mellow lofi beats, warm analog texture',
  style: 'mellow lofi beats, 82 BPM, A minor',
  title: 'Focus 1',
  instrumental: true,
  negativeTags: 'aggressive, distorted',
  model: 'V4_5',
};

describe('sunoMusicProvider', () => {
  // Hard guarantee: any accidental use of the REAL global fetch throws, so a
  // missing injection can never reach the network (and cost real money).
  const spyGlobalFetch = () => vi.spyOn(globalThis, 'fetch');
  let globalFetch: ReturnType<typeof spyGlobalFetch>;
  beforeEach(() => {
    globalFetch = spyGlobalFetch().mockImplementation(() => {
      throw new Error('network blocked in tests');
    });
  });
  afterEach(() => {
    globalFetch.mockRestore();
  });

  it('is a Suno music provider', () => {
    const { fetchImpl } = stubFetch({});
    const provider = makeProvider(fetchImpl);
    expect(provider.providerType).toBe('music');
    expect(provider.providerKey).toBe('suno');
  });

  describe('getCapabilities', () => {
    it('reports Suno reality: 2 tracks/request, both modes, stream + final', () => {
      const provider = makeProvider(stubFetch({}).fetchImpl);
      const caps = provider.getCapabilities();
      expect(caps.typicalTracksPerRequest).toBe(2);
      expect(caps.generationModes).toEqual(['non_custom', 'custom']);
      expect(caps.supportsInstrumental).toBe(true);
      expect(caps.supportsVocals).toBe(true);
      expect(caps.supportsStreamUrl).toBe(true);
      expect(caps.supportsFinalAudioUrl).toBe(true);
      // The current provider model set (V3_5 was retired upstream).
      expect(caps.modelOptions).toEqual(['V4', 'V4_5', 'V4_5PLUS', 'V4_5ALL', 'V5', 'V5_5']);
      // Style/title caps advertise the configured DEFAULT model (V4 here); the
      // prompt cap is the non-custom description cap (custom prompt is lyrics).
      expect(caps.maxStyleLength).toBe(200);
      expect(caps.maxTitleLength).toBe(80);
      expect(caps.maxPromptLength).toBe(500);
      expect(caps.expectedStreamLatencySeconds).toEqual([30, 40]);
      expect(caps.expectedFinalLatencySeconds).toEqual([120, 180]);
      expect(caps.providerRetentionNote).toMatch(/download|store|temporar/i);
    });
  });

  describe('estimateGenerationCost', () => {
    it('is pure: 1 provider call -> 2 tracks, no network, no hardcoded credits', () => {
      const { fetchImpl, calls } = stubFetch({});
      const provider = makeProvider(fetchImpl);
      const estimate = provider.estimateGenerationCost(CUSTOM_INPUT);
      expect(estimate).toMatchObject({ providerCalls: 1, expectedTracks: 2 });
      expect(estimate.estimatedCredits).toBeUndefined();
      expect(calls).toHaveLength(0);
    });
  });

  describe('createGenerationTask', () => {
    it('submits a NON-custom body and returns a pending task with the persisted taskId', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const task = await makeProvider(fetchImpl).createGenerationTask(NON_CUSTOM_INPUT);

      expect(task.providerTaskId).toBe(SUNO_TASK_ID);
      expect(task.status).toBe('pending');
      expect(task.provider).toMatchObject({ providerType: 'music', providerKey: 'suno' });

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.method).toBe('POST');
      expect(call?.url).toBe(`${BASE_URL}${GENERATE_PATH}`);
      expect(call?.authorization).toBe(`Bearer ${API_KEY}`);
      const body = call?.body as Record<string, unknown>;
      expect(body.customMode).toBe(false);
      expect(body.prompt).toBe(NON_CUSTOM_INPUT.prompt);
      expect(body.instrumental).toBe(true);
      expect(body.callBackUrl).toBe(CALLBACK_URL);
      expect(body.model).toBe('V4'); // default
      // No custom-only fields leak into a non-custom request.
      expect(body.style).toBeUndefined();
      expect(body.title).toBeUndefined();

      // The submitted body and the provider's envelope ride the task as redacted
      // diagnostics, so the worker can persist what was actually asked for.
      expect(task.diagnostics?.rawRequest).toMatchObject({
        prompt: NON_CUSTOM_INPUT.prompt,
        model: 'V4',
      });
      expect(task.diagnostics?.rawResponse).toMatchObject({ code: 200 });
    });

    it('sends the unresolvable default callback address when none is configured', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const provider = sunoMusicProvider({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl });
      await provider.createGenerationTask(NON_CUSTOM_INPUT);

      const body = calls[0]?.body as Record<string, unknown>;
      expect(body.callBackUrl).toBe('https://callback.invalid/');
    });

    it('submits a CUSTOM instrumental body that includes style + title (+ model/negativeTags)', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const task = await makeProvider(fetchImpl).createGenerationTask(CUSTOM_INPUT);

      expect(task.provider.model).toBe('V4_5');
      const body = calls[0]?.body as Record<string, unknown>;
      expect(body.customMode).toBe(true);
      expect(body.style).toBe(CUSTOM_INPUT.style);
      expect(body.title).toBe(CUSTOM_INPUT.title);
      expect(body.instrumental).toBe(true);
      expect(body.model).toBe('V4_5');
      expect(body.negativeTags).toBe('aggressive, distorted');
    });

    it('rejects a custom instrumental request missing style/title WITHOUT a network call', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const provider = makeProvider(fetchImpl);
      await expect(
        provider.createGenerationTask({ mode: 'custom', prompt: 'x', instrumental: true }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it('rejects an unknown model BEFORE any network call (sanitized)', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const provider = makeProvider(fetchImpl);
      const error = await provider
        .createGenerationTask({ ...NON_CUSTOM_INPUT, model: 'NOT_A_REAL_MODEL' })
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect(calls).toHaveLength(0);
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it('throws a SANITIZED error on a non-200 HTTP submit (no key, no raw text/url)', async () => {
      const { fetchImpl } = stubFetch({
        [GENERATE_PATH]: { status: 500, body: { code: 500, msg: 'boom' } },
      });
      const provider = makeProvider(fetchImpl);
      const error = await provider.createGenerationTask(NON_CUSTOM_INPUT).catch((e: unknown) => e);
      expectSanitized(error);
    });

    it('throws a SANITIZED error when the submit response has no taskId', async () => {
      const { fetchImpl } = stubFetch({ [GENERATE_PATH]: { body: submitMissingTaskId } });
      const provider = makeProvider(fetchImpl);
      const error = await provider.createGenerationTask(NON_CUSTOM_INPUT).catch((e: unknown) => e);
      expectSanitized(error);
    });

    it('throws a SANITIZED error when the API returns code != 200 (HTTP 200)', async () => {
      const { fetchImpl } = stubFetch({ [GENERATE_PATH]: { body: submitErrorCode } });
      const provider = makeProvider(fetchImpl);
      const error = await provider.createGenerationTask(NON_CUSTOM_INPUT).catch((e: unknown) => e);
      expectSanitized(error);
    });

    it('does NOT auto-retry a failed submit (worker owns exactly-once)', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { status: 500, body: {} } });
      await expect(
        makeProvider(fetchImpl).createGenerationTask(NON_CUSTOM_INPUT),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
    });

    // Spend classification: only a rejection that PROVES the
    // provider created no task may be flagged unbilled — the money path parks
    // those without counting them toward the budget window. Getting this wrong
    // in either direction is a money bug: too loose double-pays, too strict
    // burns the whole window on a provider outage.
    describe('unbilled-rejection classification', () => {
      async function submitError(route: { status?: number; body: unknown }): Promise<unknown> {
        const { fetchImpl } = stubFetch({ [GENERATE_PATH]: route });
        return makeProvider(fetchImpl)
          .createGenerationTask(NON_CUSTOM_INPUT)
          .catch((e: unknown) => e);
      }

      it('flags a definitive 4xx HTTP rejection as unbilled', async () => {
        const error = await submitError({ status: 400, body: { code: 400, msg: 'boom' } });
        expect(error).toBeInstanceOf(ProviderUnbilledError);
        expectSanitized(error);
      });

      it('flags a definitive rejection carried in the envelope code (HTTP 200)', async () => {
        const error = await submitError({ body: submitErrorCode }); // code 429, no taskId
        expect(error).toBeInstanceOf(ProviderUnbilledError);
      });

      it('leaves a 5xx submit failure BILLABLE (the provider may have charged)', async () => {
        const error = await submitError({ status: 503, body: { code: 503 } });
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).not.toBeInstanceOf(ProviderUnbilledError);
      });

      it('leaves a transport failure BILLABLE', async () => {
        const fetchImpl = (async () => {
          throw new Error('socket hang up');
        }) as typeof fetch;
        const error = await makeProvider(fetchImpl)
          .createGenerationTask(NON_CUSTOM_INPUT)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).not.toBeInstanceOf(ProviderUnbilledError);
      });

      it('leaves a 200 response with an unusable body BILLABLE (outcome unknown)', async () => {
        const error = await submitError({ body: submitMissingTaskId }); // code 200, no taskId
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).not.toBeInstanceOf(ProviderUnbilledError);
      });

      it('leaves a 4xx that may mean an already-created task BILLABLE', async () => {
        for (const status of [408, 409]) {
          const error = await submitError({ status, body: { code: status } });
          expect(error).not.toBeInstanceOf(ProviderUnbilledError);
        }
      });

      it('flags a pre-network input rejection as unbilled', async () => {
        const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
        const error = await makeProvider(fetchImpl)
          .createGenerationTask({ ...NON_CUSTOM_INPUT, model: 'NOT_A_REAL_MODEL' })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderUnbilledError);
        expect(calls).toHaveLength(0);
      });

      // Out of credits and maintenance clear without any change to the request,
      // so the money path must be able to tell them from a refusal of the prompt.
      it('names an out-of-credits refusal on either channel', async () => {
        for (const route of [{ status: 429, body: {} }, { body: submitErrorCode }]) {
          const error = await submitError(route);
          expect(error).toBeInstanceOf(ProviderUnbilledError);
          expect((error as ProviderUnbilledError).refusal).toBe('insufficient_credit');
        }
      });

      it('names a maintenance refusal on either channel', async () => {
        for (const route of [
          { status: 455, body: {} },
          { body: { code: 455, msg: 'maintenance', data: null } },
        ]) {
          const error = await submitError(route);
          expect(error).toBeInstanceOf(ProviderUnbilledError);
          expect((error as ProviderUnbilledError).refusal).toBe('provider_unavailable');
        }
      });

      it('names a rate-limit refusal (405 rate limit, 430 call frequency) on either channel', async () => {
        for (const code of [405, 430]) {
          for (const route of [
            { status: code, body: {} },
            { body: { code, msg: 'slow down', data: null } },
          ]) {
            const error = await submitError(route);
            expect(error).toBeInstanceOf(ProviderUnbilledError);
            expect((error as ProviderUnbilledError).refusal).toBe('rate_limited');
          }
        }
      });

      it('names no reason for a refusal of the request itself', async () => {
        const error = await submitError({ status: 400, body: { code: 400, msg: 'boom' } });
        expect(error).toBeInstanceOf(ProviderUnbilledError);
        expect((error as ProviderUnbilledError).refusal).toBeUndefined();
      });
    });
  });

  describe('request length caps — clamped at the boundary, never a failed submit', () => {
    async function submittedBody(input: MusicGenerationInput): Promise<Record<string, string>> {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      await makeProvider(fetchImpl).createGenerationTask(input);
      return calls[0]?.body as Record<string, string>;
    }

    it('clamps an over-long style/title to the DEFAULT model (V4) caps', async () => {
      const body = await submittedBody({
        mode: 'custom',
        prompt: 'p',
        style: 's'.repeat(1500),
        title: 't'.repeat(200),
        instrumental: true,
      });
      expect(body.style).toHaveLength(200);
      expect(body.title).toHaveLength(80);
    });

    it('clamps to the looser caps of a V4_5+ model', async () => {
      const body = await submittedBody({
        mode: 'custom',
        prompt: 'p',
        style: 's'.repeat(1500),
        title: 't'.repeat(200),
        instrumental: true,
        model: 'V4_5',
      });
      expect(body.style).toHaveLength(1000);
      expect(body.title).toHaveLength(100);
    });

    it("clamps to V4_5ALL's mixed profile (loose style, tight title)", async () => {
      const body = await submittedBody({
        mode: 'custom',
        prompt: 'p',
        style: 's'.repeat(1500),
        title: 't'.repeat(200),
        instrumental: true,
        model: 'V4_5ALL',
      });
      expect(body.style).toHaveLength(1000);
      expect(body.title).toHaveLength(80);
    });

    it('leaves a within-cap style/title untouched (the clamp only ever truncates)', async () => {
      const body = await submittedBody(CUSTOM_INPUT);
      expect(body.style).toBe(CUSTOM_INPUT.style);
      expect(body.title).toBe(CUSTOM_INPUT.title);
    });

    it('clamps a non-custom prompt to the description cap', async () => {
      const body = await submittedBody({ ...NON_CUSTOM_INPUT, prompt: 'p'.repeat(800) });
      expect(body.prompt).toHaveLength(500);
    });
  });

  describe('Session Guardrails — the only place their Suno parameter names exist', () => {
    async function submittedBody(input: MusicGenerationInput): Promise<Record<string, unknown>> {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      await makeProvider(fetchImpl).createGenerationTask(input);
      return calls[0]?.body as Record<string, unknown>;
    }

    it('maps the levels onto styleWeight/weirdnessConstraint on a custom instrumental body', async () => {
      const body = await submittedBody({ ...CUSTOM_INPUT, styleStrength: 0.65, novelty: 0.3 });
      expect(body.styleWeight).toBe(0.65);
      expect(body.weirdnessConstraint).toBe(0.3);
    });

    it('sends the levels on the VOCAL non-custom body too', async () => {
      const body = await submittedBody({
        mode: 'custom',
        prompt: 'dream pop, airy, 96 bpm, A minor',
        style: 'dream pop, airy, 96 bpm, A minor',
        title: 'Evening 1',
        instrumental: false,
        styleStrength: 0.4,
        novelty: 0.8,
      });
      expect(body.customMode).toBe(false);
      expect(body.styleWeight).toBe(0.4);
      expect(body.weirdnessConstraint).toBe(0.8);
    });

    it('sends the levels on the USER-VOICE persona body too', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      await sunoMusicProvider({
        apiKey: API_KEY,
        callbackUrl: CALLBACK_URL,
        defaultModel: 'V5_5',
        lyricsPollIntervalMs: 0,
        fetch: fetchImpl,
      }).createGenerationTask({
        mode: 'custom',
        prompt: 'dream pop, airy, 96 bpm, A minor',
        style: 'dream pop, airy, 96 bpm, A minor',
        title: 'Evening 1',
        instrumental: false,
        styleStrength: 0.55,
        novelty: 0.15,
        customVoice: { providerVoiceId: PROVIDER_VOICE_ID },
      });
      const body = calls.find((call) => new URL(call.url).pathname === GENERATE_PATH)!
        .body as Record<string, unknown>;
      expect(body.styleWeight).toBe(0.55);
      expect(body.weirdnessConstraint).toBe(0.15);
    });

    it('sends NEITHER knob for a pre-guardrails input (a legacy reroll keeps its sound)', async () => {
      const body = await submittedBody(CUSTOM_INPUT);
      expect(body).not.toHaveProperty('styleWeight');
      expect(body).not.toHaveProperty('weirdnessConstraint');
    });

    it('sends a level of 0 — the loosest setting is a value, not an absent one', async () => {
      const body = await submittedBody({ ...CUSTOM_INPUT, styleStrength: 0, novelty: 0 });
      expect(body.styleWeight).toBe(0);
      expect(body.weirdnessConstraint).toBe(0);
    });

    it('clamps out-of-range levels and rounds to the API 0.01 increments', async () => {
      const body = await submittedBody({ ...CUSTOM_INPUT, styleStrength: 1.4, novelty: -0.2 });
      expect(body.styleWeight).toBe(1);
      expect(body.weirdnessConstraint).toBe(0);

      const rounded = await submittedBody({
        ...CUSTOM_INPUT,
        styleStrength: 0.3333,
        novelty: 0.789,
      });
      expect(rounded.styleWeight).toBe(0.33);
      expect(rounded.weirdnessConstraint).toBe(0.79);
    });

    it('truncates over-long negativeTags at a comma boundary (never half a term)', async () => {
      const term = 'saxophone solos';
      const body = await submittedBody({
        ...CUSTOM_INPUT,
        negativeTags: `vocals, ${`${term}, `.repeat(60)}tail`,
      });
      const negativeTags = body.negativeTags as string;
      expect(negativeTags.length).toBeLessThanOrEqual(500);
      expect(negativeTags.endsWith(term)).toBe(true);
    });
  });

  describe('configured default model', () => {
    it('advertises the configured default model caps through getCapabilities', () => {
      const provider = sunoMusicProvider({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        defaultModel: 'V4_5',
        fetch: stubFetch({}).fetchImpl,
      });
      const caps = provider.getCapabilities();
      expect(caps.maxStyleLength).toBe(1000);
      expect(caps.maxTitleLength).toBe(100);
    });

    it('rejects an unknown default model at CONSTRUCTION with a sanitized config error', () => {
      // A stale configured model (e.g. the retired V3_5) must fail fast at boot,
      // not opaquely on the first paid submit.
      expect(() =>
        sunoMusicProvider({
          apiKey: API_KEY,
          baseUrl: BASE_URL,
          defaultModel: 'V3_5',
          fetch: stubFetch({}).fetchImpl,
        }),
      ).toThrow(/choose one of/i);
    });
  });

  describe('vocal requests — custom-mode prompt is LYRICS, so vocals go non-custom', () => {
    const VOCAL_CUSTOM_INPUT: MusicGenerationInput = {
      mode: 'custom',
      prompt: 'dream pop, airy, spacious reverb tail, 96 bpm, A minor',
      style: 'dream pop, airy, spacious reverb tail, 96 bpm, A minor',
      title: 'Evening 1',
      instrumental: false,
      negativeTags: 'harsh noise',
    };

    it('submits a vocal custom-mode input as a NON-custom body (description, not lyrics)', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      await makeProvider(fetchImpl).createGenerationTask(VOCAL_CUSTOM_INPUT);
      const body = calls[0]?.body as Record<string, unknown>;
      expect(body.customMode).toBe(false);
      // The description rides as the non-custom prompt (the provider writes its own
      // lyrics from it) — never as custom-mode lyrics that would be sung verbatim.
      expect(body.prompt).toBe(VOCAL_CUSTOM_INPUT.prompt);
      expect(body.instrumental).toBe(false);
      expect(body.negativeTags).toBe('harsh noise');
      // Custom-mode-only fields stay unsent in non-custom mode.
      expect(body.style).toBeUndefined();
      expect(body.title).toBeUndefined();
    });

    it('rejects a vocal request with no prompt WITHOUT a network call', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const error = await makeProvider(fetchImpl)
        .createGenerationTask({ ...VOCAL_CUSTOM_INPUT, prompt: '' })
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect(calls).toHaveLength(0);
    });
  });

  describe('user-voice requests — persona is custom-mode-only, so lyrics are written first', () => {
    const OWN_VOICE_INPUT: MusicGenerationInput = {
      mode: 'custom',
      prompt: 'dream pop, airy, spacious reverb tail, 96 bpm, A minor',
      style: 'dream pop, airy, spacious reverb tail, 96 bpm, A minor',
      title: 'Evening 1',
      instrumental: false,
      negativeTags: 'harsh noise',
      customVoice: { providerVoiceId: PROVIDER_VOICE_ID },
    };

    function makeVoiceModelProvider(fetchImpl: typeof fetch) {
      return sunoMusicProvider({
        apiKey: API_KEY,
        callbackUrl: CALLBACK_URL,
        defaultModel: 'V5_5',
        lyricsPollIntervalMs: 0,
        fetch: fetchImpl,
      });
    }

    // A compatible (non-official) base URL WITH a persona-capable default model:
    // the voice workflow is gated off by the base URL, never the model.
    function makeMirrorProvider(fetchImpl: typeof fetch) {
      return sunoMusicProvider({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        defaultModel: 'V5_5',
        fetch: fetchImpl,
      });
    }

    it('writes lyrics, then submits ONE custom-mode generate with personaId/voice_persona', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      const task = await makeVoiceModelProvider(fetchImpl).createGenerationTask(OWN_VOICE_INPUT);
      expect(task.providerTaskId).toBe(SUNO_TASK_ID);

      const generateCalls = calls.filter((call) => call.url.includes(GENERATE_PATH));
      expect(generateCalls).toHaveLength(1);
      const body = generateCalls[0]!.body as Record<string, unknown>;
      expect(body).toMatchObject({
        customMode: true,
        instrumental: false,
        model: 'V5_5',
        style: OWN_VOICE_INPUT.style,
        title: OWN_VOICE_INPUT.title,
        // The written lyrics — NOT the description — ride custom-mode `prompt`.
        prompt: GENERATED_LYRICS,
        personaId: PROVIDER_VOICE_ID,
        personaModel: 'voice_persona',
        negativeTags: 'harsh noise',
      });
    });

    it('briefs the lyrics writer with the language directive and lyric brief, within the cap', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      await makeVoiceModelProvider(fetchImpl).createGenerationTask({
        ...OWN_VOICE_INPUT,
        language: 'German',
        lyricBrief: 'people: John at desk; setting: Berlin late night, glowing screen',
      });
      const lyricsCall = calls.find((call) => new URL(call.url).pathname === LYRICS_PATH);
      const brief = (lyricsCall!.body as { prompt: string }).prompt;
      // The language directive leads (it must survive any clamp — it is the
      // difference between German and English vocals), then the lyric direction.
      expect(brief).toMatch(/^Write the lyrics in German\./);
      expect(brief).toContain('John at desk');
      expect(brief.length).toBeLessThanOrEqual(200);
    });

    it('keeps the language directive when a long lyric brief hits the 200-char cap', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      await makeVoiceModelProvider(fetchImpl).createGenerationTask({
        ...OWN_VOICE_INPUT,
        language: 'German',
        lyricBrief: 'x'.repeat(500),
      });
      const lyricsCall = calls.find((call) => new URL(call.url).pathname === LYRICS_PATH);
      const brief = (lyricsCall!.body as { prompt: string }).prompt;
      expect(brief).toMatch(/^Write the lyrics in German\./);
      expect(brief.length).toBeLessThanOrEqual(200);
    });

    it('falls back to the description as the lyrics brief without language or lyric brief', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      await makeVoiceModelProvider(fetchImpl).createGenerationTask(OWN_VOICE_INPUT);
      const lyricsCall = calls.find((call) => new URL(call.url).pathname === LYRICS_PATH);
      const brief = (lyricsCall!.body as { prompt: string }).prompt;
      expect(brief).toBe(OWN_VOICE_INPUT.prompt);
    });

    it('keeps polling the lyrics task until SUCCESS before the paid generate', async () => {
      let pollCount = 0;
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes(LYRICS_RECORD_INFO_PATH)) {
          pollCount += 1;
          return new Response(
            JSON.stringify(pollCount < 3 ? lyricsRecordInfoPending : lyricsRecordInfoSuccess),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return fetchImpl(input as string, init);
      }) as typeof fetch;
      await makeVoiceModelProvider(routedFetch).createGenerationTask(OWN_VOICE_INPUT);
      expect(pollCount).toBe(3);
      expect(calls.filter((call) => call.url.includes(GENERATE_PATH))).toHaveLength(1);
    });

    it('bounds a never-finishing lyrics task to 10 polls (~30s live) — a worker slot is at stake', async () => {
      let pollCount = 0;
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes(LYRICS_RECORD_INFO_PATH)) {
          pollCount += 1;
          return new Response(JSON.stringify(lyricsRecordInfoPending), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return fetchImpl(input as string, init);
      }) as typeof fetch;
      const error = await makeVoiceModelProvider(routedFetch)
        .createGenerationTask(OWN_VOICE_INPUT)
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect((error as Error).message).toBe(
        'The music provider could not write lyrics for this request.',
      );
      expect(pollCount).toBe(10);
      expect(calls.some((call) => call.url.includes(GENERATE_PATH))).toBe(false);
    });

    it('fails sanitized BEFORE the paid generate when the lyrics task fails', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoFailed },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      const error = await makeVoiceModelProvider(fetchImpl)
        .createGenerationTask(OWN_VOICE_INPUT)
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect((error as Error).message).toBe(
        'The music provider could not write lyrics for this request.',
      );
      expect(calls.some((call) => call.url.includes(GENERATE_PATH))).toBe(false);
    });

    it('keeps a rejected own-voice submit BILLABLE — its lyrics call already charged', async () => {
      // The own-voice path pays for lyrics before the generate POST goes out. A
      // definitive rejection of that POST proves the GENERATION was not charged,
      // but the credits for the lyrics are already spent — flagging the whole
      // submit unbilled would drop them from the spend window silently.
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { status: 400, body: { code: 400, msg: 'boom' } },
      });
      const error = await makeVoiceModelProvider(fetchImpl)
        .createGenerationTask(OWN_VOICE_INPUT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(ProviderUnbilledError);
      expect(calls.some((call) => call.url.includes(GENERATE_PATH))).toBe(true);
    });

    it('reports an own-voice submit UNBILLED when the lyrics call itself is refused', async () => {
      // A definitive refusal of the lyrics submit (here: out of credits) proves
      // no lyrics task was created, and the generate POST never goes out — so
      // nothing was charged and the refusal must reach the caller's cooldown.
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: { code: 429, msg: 'insufficient credits' } },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      const error = await makeVoiceModelProvider(fetchImpl)
        .createGenerationTask(OWN_VOICE_INPUT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderUnbilledError);
      expect((error as ProviderUnbilledError).refusal).toBe('insufficient_credit');
      expect(calls.some((call) => call.url.includes(GENERATE_PATH))).toBe(false);
    });

    it('rejects an instrumental user-voice request WITHOUT a network call', async () => {
      const { fetchImpl, calls } = stubFetch({});
      const error = await makeVoiceModelProvider(fetchImpl)
        .createGenerationTask({ ...OWN_VOICE_INPUT, instrumental: true })
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect(calls).toHaveLength(0);
    });

    it('pins V5_5 for a user-voice request on a non-persona default model', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      // Default model V4: the persona model is pinned for the own-voice request
      // only — the configured model keeps governing every other request.
      const task = await sunoMusicProvider({
        apiKey: API_KEY,
        fetch: fetchImpl,
      }).createGenerationTask(OWN_VOICE_INPUT);
      const generate = calls.find((call) => new URL(call.url).pathname === GENERATE_PATH);
      expect((generate!.body as Record<string, unknown>).model).toBe('V5_5');
      expect(task.provider.model).toBe('V5_5');
    });

    it('pins V5_5 even when the input overrides the model to V5', async () => {
      const { fetchImpl, calls } = stubFetch({
        [LYRICS_PATH]: { body: lyricsSubmitSuccess },
        [LYRICS_RECORD_INFO_PATH]: { body: lyricsRecordInfoSuccess },
        [GENERATE_PATH]: { body: submitSuccess },
      });
      await makeVoiceModelProvider(fetchImpl).createGenerationTask({
        ...OWN_VOICE_INPUT,
        model: 'V5',
      });
      const generate = calls.find((call) => new URL(call.url).pathname === GENERATE_PATH);
      expect((generate!.body as Record<string, unknown>).model).toBe('V5_5');
    });

    it('rejects a user-voice request through a custom base URL without a network call', async () => {
      const { fetchImpl, calls } = stubFetch({});
      const error = await makeMirrorProvider(fetchImpl)
        .createGenerationTask(OWN_VOICE_INPUT)
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect(calls).toHaveLength(0);
    });

    it('rejects a user-voice request missing style/title WITHOUT any spend', async () => {
      const { fetchImpl, calls } = stubFetch({});
      const error = await makeVoiceModelProvider(fetchImpl)
        .createGenerationTask({ ...OWN_VOICE_INPUT, style: undefined })
        .catch((e: unknown) => e);
      expectSanitized(error);
      expect(calls).toHaveLength(0);
    });

    it('advertises customVoice support and the persona style cap regardless of the default model (the adapter pins V5_5)', () => {
      const { fetchImpl } = stubFetch({});
      // Default model V4 (200-char style), official base URL: still supported,
      // and own-voice compiles budget against V5_5's 1000-char style cap.
      const capabilities = sunoMusicProvider({
        apiKey: API_KEY,
        fetch: fetchImpl,
      }).getCapabilities();
      expect(capabilities.maxStyleLength).toBe(200);
      expect(capabilities.customVoice).toEqual({
        supported: true,
        maxVoicesPerGeneration: 1,
        requiresVerificationPhrase: true,
        supportedModels: ['V5_5'],
        maxStyleLength: 1000,
      });
      // A custom base URL has no voice workflow, so support stays off there.
      expect(makeProvider(fetchImpl).getCapabilities().customVoice?.supported).toBe(false);
    });

    it('exposes the voice-setup sub-API', () => {
      const { fetchImpl } = stubFetch({});
      expect(sunoMusicProvider({ apiKey: API_KEY, fetch: fetchImpl }).voice).toBeDefined();
    });

    it('does not expose voice setup or generation support through a custom base URL', () => {
      const { fetchImpl } = stubFetch({});
      const provider = makeMirrorProvider(fetchImpl);
      expect(provider.voice).toBeUndefined();
      expect(provider.getCapabilities().customVoice?.supported).toBe(false);
    });
  });

  describe('getGenerationStatus — lifecycle mapping', () => {
    const cases: Array<[string, unknown, string]> = [
      ['PENDING -> pending', recordInfoPending, 'pending'],
      ['TEXT_SUCCESS -> text_ready', recordInfoTextSuccess, 'text_ready'],
      ['FIRST_SUCCESS -> first_track_ready', recordInfoFirstSuccess, 'first_track_ready'],
      ['SUCCESS -> complete', recordInfoSuccess, 'complete'],
    ];
    it.each(cases)('maps %s', async (_name, fixture, expected) => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: fixture } });
      const result = await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
      expect(result.status).toBe(expected);
      expect(result.provider.providerKey).toBe('suno');
    });

    it('queries record-info by taskId with the bearer key', async () => {
      const { fetchImpl, calls } = stubFetch({ [RECORD_INFO_PATH]: { body: recordInfoPending } });
      await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('GET');
      expect(calls[0]?.authorization).toBe(`Bearer ${API_KEY}`);
      const url = new URL(calls[0]?.url ?? '');
      expect(url.pathname).toBe(RECORD_INFO_PATH);
      expect(url.searchParams.get('taskId')).toBe(SUNO_TASK_ID);
    });
  });

  describe('getGenerationStatus — failure mapping (a failed JOB does NOT throw)', () => {
    const cases: Array<[string, unknown, string]> = [
      // Failure token carried in `status`.
      ['GENERATE_AUDIO_FAILED -> generation_failed', recordInfoGenerateFailed, 'generation_failed'],
      ['CREATE_TASK_FAILED -> generation_failed', recordInfoCreateTaskFailed, 'generation_failed'],
      ['CALLBACK_EXCEPTION -> generation_failed', recordInfoCallbackException, 'generation_failed'],
      ['SENSITIVE_WORD_ERROR -> sensitive_content', recordInfoSensitiveWord, 'sensitive_content'],
      [
        'insufficient credit -> insufficient_credit',
        recordInfoInsufficientCredit,
        'insufficient_credit',
      ],
      ['unrecognized failure -> unknown', recordInfoUnknownFailure, 'unknown'],
      // Failure token carried in error fields while `status` is STILL a progress value:
      // the hard-error signal must beat the progress check (field-agnostic).
      [
        'errorCode token beats a progress status -> generation_failed',
        recordInfoErrorFieldGenerateFailed,
        'generation_failed',
      ],
      [
        'errorMessage credit beats a progress status -> insufficient_credit',
        recordInfoErrorFieldInsufficientCredit,
        'insufficient_credit',
      ],
    ];
    it.each(cases)('maps %s', async (_name, fixture, expectedReason) => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: fixture } });
      const result = await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
      expect(result.status).toBe('failed');
      expect(result.failureReason).toBe(expectedReason);
    });

    it('does NOT misread a normal payload with absent/empty error fields as failed', async () => {
      // PENDING/TEXT_SUCCESS/SUCCESS with null error fields stay on their lifecycle...
      for (const [fixture, expected] of [
        [recordInfoPending, 'pending'],
        [recordInfoTextSuccess, 'text_ready'],
        [recordInfoSuccess, 'complete'],
      ] as const) {
        const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: fixture } });
        const result = await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
        expect(result.status).toBe(expected);
        expect(result.failureReason).toBeUndefined();
      }
      // ...and a SUCCESS whose error fields are present but EMPTY (0 / '') is NOT a failure.
      const { fetchImpl } = stubFetch({
        [RECORD_INFO_PATH]: { body: recordInfoSuccessEmptyError },
      });
      const result = await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
      expect(result.status).toBe('complete');
      expect(result.failureReason).toBeUndefined();
      expect(result.tracks).toHaveLength(2);
    });

    it('throws (sanitized) only on a transport/HTTP/parse error, not a failed job', async () => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { status: 500, body: { code: 500 } } });
      const error = await makeProvider(fetchImpl)
        .getGenerationStatus(SUNO_TASK_ID)
        .catch((e: unknown) => e);
      expectSanitized(error);
    });

    it.each([
      ['null data', recordInfoMissingData],
      ['null status', recordInfoMissingStatus],
    ])(
      'treats code:200 with missing status and no hard error (%s) as a RETRYABLE call failure, not a failed job',
      async (_name, fixture) => {
        // A read racing task creation must never mark an already-paid task failed.
        const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: fixture } });
        const error = await makeProvider(fetchImpl)
          .getGenerationStatus(SUNO_TASK_ID)
          .catch((e: unknown) => e);
        expectSanitized(error);
      },
    );
  });

  describe('getGenerationStatus — track normalization', () => {
    it('TEXT_SUCCESS yields 2 stream-only tracks (no audioUrl, no duration)', async () => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: recordInfoTextSuccess } });
      const { tracks } = await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
      expect(tracks).toHaveLength(2);
      for (const track of tracks) {
        expect(track.providerTrackId.length).toBeGreaterThan(0);
        expect(track.streamAudioUrl).toBeTruthy();
        expect(track.audioUrl).toBeUndefined(); // "" treated as absent
        expect(track.durationSeconds).toBeUndefined(); // null treated as absent
        expect(track.model).toBe('chirp-auk-turbo');
      }
      expect(tracks[0]?.providerTrackId).not.toBe(tracks[1]?.providerTrackId);
    });

    it('SUCCESS yields 2 final tracks with audioUrl + duration', async () => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: recordInfoSuccess } });
      const { tracks } = await makeProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID);
      expect(tracks).toHaveLength(2);
      for (const track of tracks) {
        expect(track.audioUrl).toBeTruthy();
        expect(typeof track.durationSeconds).toBe('number');
        expect(track.streamAudioUrl).toBeTruthy();
      }
    });

    it('normalizeProviderTrack: id/title/urls/duration/model, "" -> absent, null -> absent', () => {
      const provider = makeProvider(stubFetch({}).fetchImpl);
      const streamOnly = provider.normalizeProviderTrack({
        id: 't-1',
        title: 'T',
        streamAudioUrl: 'https://cdn.example/stream/t-1',
        audioUrl: '',
        duration: null,
        modelName: 'chirp-auk-turbo',
      });
      expect(streamOnly).toEqual({
        providerTrackId: 't-1',
        title: 'T',
        streamAudioUrl: 'https://cdn.example/stream/t-1',
        model: 'chirp-auk-turbo',
      });

      const final = provider.normalizeProviderTrack({
        id: 't-2',
        title: 'T2',
        streamAudioUrl: 'https://cdn.example/stream/t-2',
        audioUrl: 'https://cdn.example/final/t-2.mp3',
        duration: 167.24,
        modelName: 'chirp-auk-turbo',
      });
      expect(final.audioUrl).toBe('https://cdn.example/final/t-2.mp3');
      expect(final.durationSeconds).toBe(167.24);
    });

    it('maps a vocal track `prompt` to lyrics; "" and "[Instrumental]" -> absent', () => {
      const provider = makeProvider(stubFetch({}).fetchImpl);
      expect(provider.normalizeProviderTrack(finalVocalTrack).lyrics).toBe(VOCAL_LYRICS);
      expect(provider.normalizeProviderTrack({ id: 't-1', prompt: '' }).lyrics).toBeUndefined();
      expect(
        provider.normalizeProviderTrack({ id: 't-1', prompt: '[Instrumental]' }).lyrics,
      ).toBeUndefined();
    });
  });

  describe('getTimestampedLyrics', () => {
    it('POSTs taskId+audioId with auth and maps alignedWords + hootCer', async () => {
      const { fetchImpl, calls } = stubFetch({
        [TIMESTAMPED_LYRICS_PATH]: { body: timestampedLyricsSuccess },
      });
      const result = await makeProvider(fetchImpl).getTimestampedLyrics!({
        providerTaskId: SUNO_TASK_ID,
        providerTrackId: 'audio-a',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.authorization).toBe(`Bearer ${API_KEY}`);
      expect(calls[0]?.body).toEqual({ taskId: SUNO_TASK_ID, audioId: 'audio-a' });
      expect(result).toEqual({
        alignmentErrorScore: 0.05,
        words: [
          { word: '[Verse]\n', startSeconds: 0, endSeconds: 0.4, success: false },
          { word: 'Neon ', startSeconds: 6.1, endSeconds: 6.4, success: true },
          { word: 'rain ', startSeconds: 6.4, endSeconds: 6.9, success: true },
          { word: 'on the window\n', startSeconds: 6.9, endSeconds: 8.2, success: true },
          { word: '[Chorus]\n', startSeconds: 8.2, endSeconds: 8.3, success: false },
          { word: 'Keep the loop alive\n', startSeconds: 12.5, endSeconds: 15.1, success: true },
        ],
      });
    });

    it('returns null when the provider has no timing for the track', async () => {
      const { fetchImpl } = stubFetch({
        [TIMESTAMPED_LYRICS_PATH]: { body: timestampedLyricsUnavailable },
      });
      const result = await makeProvider(fetchImpl).getTimestampedLyrics!({
        providerTaskId: SUNO_TASK_ID,
        providerTrackId: 'audio-a',
      });
      expect(result).toBeNull();
    });

    it.each([
      ['HTTP failure', { status: 500, body: {} }],
      ['rejected envelope', { body: timestampedLyricsErrorCode }],
    ])('throws a sanitized error on %s', async (_label, route) => {
      const { fetchImpl } = stubFetch({ [TIMESTAMPED_LYRICS_PATH]: route });
      const error = await makeProvider(fetchImpl).getTimestampedLyrics!({
        providerTaskId: SUNO_TASK_ID,
        providerTrackId: 'audio-a',
      }).catch((e: unknown) => e);
      expectSanitized(error);
    });
  });

  describe('validateCredentials', () => {
    it('is ok and reports the numeric balance as structured data + message', async () => {
      const { fetchImpl, calls } = stubFetch({ [CREDIT_PATH]: { body: creditSuccess } });
      const result = await makeProvider(fetchImpl).validateCredentials();
      expect(result.ok).toBe(true);
      // Structured numeric balance (not just a substring of the message).
      expect(result.balance).toBe(creditSuccess.data);
      expect(result.message).toContain('1026');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('GET');
      expect(new URL(calls[0]?.url ?? '').pathname).toBe(CREDIT_PATH);
    });

    it('fails (sanitized) when the credit endpoint rejects the key', async () => {
      const { fetchImpl } = stubFetch({
        [CREDIT_PATH]: { status: 401, body: { code: 401, msg: 'unauthorized' } },
      });
      const result = await makeProvider(fetchImpl).validateCredentials();
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(API_KEY);
    });
  });

  describe('request timeout (every call is time-bounded)', () => {
    /** A fetch that never settles until the adapter's timeout signal aborts it. */
    const hungFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      })) as typeof fetch;

    function makeTimingOutProvider() {
      return sunoMusicProvider({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetch: hungFetch,
        requestTimeoutMs: 20,
      });
    }

    it('aborts a hung status poll and throws the SANITIZED transport failure', async () => {
      const error = await makeTimingOutProvider()
        .getGenerationStatus(SUNO_TASK_ID)
        .catch((e: unknown) => e);
      expectSanitized(error);
    });

    it('aborts a hung submit and throws the SANITIZED submit failure', async () => {
      const error = await makeTimingOutProvider()
        .createGenerationTask(NON_CUSTOM_INPUT)
        .catch((e: unknown) => e);
      expectSanitized(error);
    });

    it('reports a hung credential check as unreachable (transport), not rejected', async () => {
      const result = await makeTimingOutProvider().validateCredentials();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/reach/i);
    });

    /**
     * A response that STARTS but never finishes its body — the stub wires the
     * adapter's timeout signal to the body stream, as real undici does, so the
     * abort rejects `response.json()` mid-read.
     */
    const trickleBodyFetch = ((_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"code":200,'));
          init?.signal?.addEventListener('abort', () =>
            controller.error(init.signal!.reason as Error),
          );
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof fetch;

    function makeTricklingProvider() {
      return sunoMusicProvider({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        fetch: trickleBodyFetch,
        requestTimeoutMs: 20,
      });
    }

    it('aborts a MID-BODY trickle on a status poll and throws the SANITIZED failure', async () => {
      const error = await makeTricklingProvider()
        .getGenerationStatus(SUNO_TASK_ID)
        .catch((e: unknown) => e);
      expectSanitized(error);
    });

    it('maps a MID-BODY abort to transport (unreachable), never a parse rejection', async () => {
      // validateCredentials distinguishes the reasons: `transport` reports
      // "couldn't reach", `parse` would report a credential rejection.
      const result = await makeTricklingProvider().validateCredentials();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/reach/i);
    });
  });

  describe('SSRF gate (mirrors the LLM adapters)', () => {
    const METADATA_BASE_URL = 'http://169.254.169.254';

    function makeBlockedProvider(fetchImpl: typeof fetch) {
      return sunoMusicProvider({ apiKey: API_KEY, baseUrl: METADATA_BASE_URL, fetch: fetchImpl });
    }

    it('rejects a submit to a private/metadata base URL WITHOUT any network call', async () => {
      const { fetchImpl, calls } = stubFetch({ [GENERATE_PATH]: { body: submitSuccess } });
      const error = await makeBlockedProvider(fetchImpl)
        .createGenerationTask(NON_CUSTOM_INPUT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(METADATA_BASE_URL);
      expect(calls).toHaveLength(0);
    });

    it('rejects a status poll to a private/metadata base URL WITHOUT any network call', async () => {
      const { fetchImpl, calls } = stubFetch({ [RECORD_INFO_PATH]: { body: recordInfoPending } });
      await expect(
        makeBlockedProvider(fetchImpl).getGenerationStatus(SUNO_TASK_ID),
      ).rejects.toThrow(/not allowed/i);
      expect(calls).toHaveLength(0);
    });

    it('reports (not throws) a blocked base URL from validateCredentials', async () => {
      const { fetchImpl, calls } = stubFetch({ [CREDIT_PATH]: { body: creditSuccess } });
      const result = await makeBlockedProvider(fetchImpl).validateCredentials();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not allowed/i);
      expect(result.message).not.toContain(METADATA_BASE_URL);
      expect(calls).toHaveLength(0);
    });
  });

  describe('no-network guarantee', () => {
    it('never touches the real global fetch across every networked method', async () => {
      const { fetchImpl } = stubFetch({
        [GENERATE_PATH]: { body: submitSuccess },
        [RECORD_INFO_PATH]: { body: recordInfoSuccess },
        [CREDIT_PATH]: { body: creditSuccess },
      });
      const provider = makeProvider(fetchImpl);
      await provider.createGenerationTask(NON_CUSTOM_INPUT);
      await provider.getGenerationStatus(SUNO_TASK_ID);
      await provider.validateCredentials();
      expect(globalFetch).not.toHaveBeenCalled();
    });
  });
});

/** Assert a thrown error is sanitized: a real Error whose message leaks no secret/url/raw text. */
function expectSanitized(error: unknown): boolean {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).not.toContain(API_KEY);
  expect(message).not.toContain(BASE_URL);
  expect(message).not.toMatch(/https?:\/\//);
  expect(message).not.toContain('boom'); // raw provider `msg` must not surface
  return true;
}
