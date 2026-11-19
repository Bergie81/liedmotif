import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors';
import { createSunoVoiceApi } from './suno-voice';
import {
  checkVoiceAvailable,
  checkVoiceUnavailable,
  fileStreamUploadFailure,
  fileStreamUploadSuccess,
  PROVIDER_VOICE_ID,
  VERIFICATION_PHRASE,
  VOICE_CREATE_TASK_ID,
  VOICE_VALIDATE_TASK_ID,
  voiceGenerateSubmitSuccess,
  voiceRecordInfoInsufficientCredit,
  voiceRecordInfoProcessing,
  voiceRecordInfoSuccess,
  voiceValidateInfoFailed,
  voiceValidateInfoProcessing,
  voiceValidateInfoReady,
  voiceValidateSubmitSuccess,
} from './suno.fixtures';
import type { VoiceAudioSource } from './index';

const API_KEY = 'suno-secret-key-do-not-leak';
const CALLBACK_URL = 'https://callback.invalid/';

const UPLOAD_PATH = '/api/file-stream-upload';
const VALIDATE_PATH = '/api/v1/voice/validate';
const VALIDATE_INFO_PATH = '/api/v1/voice/validate-info';
const GENERATE_PATH = '/api/v1/voice/generate';
const RECORD_INFO_PATH = '/api/v1/voice/record-info';
const CHECK_VOICE_PATH = '/api/v1/voice/check-voice';

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  /** Parsed JSON body, or the collected multipart fields for a FormData body. */
  body: unknown;
}

/**
 * Fetch stub that records multipart bodies — an unexpected path throws so the
 * exact request set is proven.
 */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body instanceof FormData) {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of init.body.entries()) {
        fields[key] =
          value instanceof Blob ? { size: value.size, type: value.type } : String(value);
      }
      body = fields;
    } else if (init?.body) {
      body = JSON.parse(String(init.body));
    }
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body,
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

function makeVoiceApi(fetchImpl: typeof fetch) {
  return createSunoVoiceApi({
    apiKey: API_KEY,
    callbackUrl: CALLBACK_URL,
    fetch: fetchImpl,
    requestTimeoutMs: 30_000,
  });
}

const AUDIO: VoiceAudioSource = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: 'audio/wav',
  fileName: 'voice.wav',
};

describe('createSunoVoiceApi', () => {
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

  describe('validateSource', () => {
    it('uploads the recording, submits the returned URL, and yields the task id', async () => {
      const { fetchImpl, calls } = stubFetch({
        [UPLOAD_PATH]: { body: fileStreamUploadSuccess },
        [VALIDATE_PATH]: { body: voiceValidateSubmitSuccess },
      });
      const result = await makeVoiceApi(fetchImpl).validateSource({
        audio: AUDIO,
        vocalStartS: 0,
        vocalEndS: 24,
        language: 'en',
      });

      expect(result.providerTaskId).toBe(VOICE_VALIDATE_TASK_ID);
      expect(calls).toHaveLength(2);
      const [upload, validate] = calls;
      // The file-upload service lives on its own vendor host, NOT the API base URL.
      expect(upload!.url).toBe('https://sunoapiorg.redpandaai.co/api/file-stream-upload');
      expect(upload!.authorization).toBe(`Bearer ${API_KEY}`);
      expect(upload!.body).toMatchObject({
        file: { size: 4, type: 'audio/wav' },
        uploadPath: 'liedmotif/voice-setup',
        fileName: 'voice.wav',
      });
      expect(validate!.body).toEqual({
        voiceUrl: fileStreamUploadSuccess.data.downloadUrl,
        vocalStartS: 0,
        vocalEndS: 24,
        language: 'en',
        callBackUrl: CALLBACK_URL,
      });
    });

    it('throws a sanitized error when the upload yields no URL, without validating', async () => {
      const { fetchImpl, calls } = stubFetch({
        [UPLOAD_PATH]: { body: fileStreamUploadFailure },
      });
      await expect(
        makeVoiceApi(fetchImpl).validateSource({ audio: AUDIO, vocalStartS: 0, vocalEndS: 24 }),
      ).rejects.toThrow('Could not deliver the recording to the music provider.');
      expect(calls).toHaveLength(1);
    });

    it('never leaks the temporary URL or provider body in a submit failure', async () => {
      const { fetchImpl } = stubFetch({
        [UPLOAD_PATH]: { body: fileStreamUploadSuccess },
        [VALIDATE_PATH]: { status: 500, body: { code: 500, msg: 'boom secret' } },
      });
      const error = await makeVoiceApi(fetchImpl)
        .validateSource({ audio: AUDIO, vocalStartS: 0, vocalEndS: 24 })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProviderError);
      const message = (error as Error).message;
      expect(message).not.toContain('tempfile');
      expect(message).not.toContain('secret');
      expect(message).not.toContain(API_KEY);
    });
  });

  describe('getValidationStatus', () => {
    it('reports processing while the phrase is absent', async () => {
      const { fetchImpl, calls } = stubFetch({
        [VALIDATE_INFO_PATH]: { body: voiceValidateInfoProcessing },
      });
      const result = await makeVoiceApi(fetchImpl).getValidationStatus(VOICE_VALIDATE_TASK_ID);
      expect(result).toEqual({ status: 'processing' });
      expect(calls[0]!.url).toContain(`taskId=${VOICE_VALIDATE_TASK_ID}`);
    });

    it('completes with the verification phrase once present', async () => {
      const { fetchImpl } = stubFetch({ [VALIDATE_INFO_PATH]: { body: voiceValidateInfoReady } });
      const result = await makeVoiceApi(fetchImpl).getValidationStatus(VOICE_VALIDATE_TASK_ID);
      expect(result).toEqual({ status: 'complete', verificationPhrase: VERIFICATION_PHRASE });
    });

    it('maps a failed validation to a sanitized failure', async () => {
      const { fetchImpl } = stubFetch({ [VALIDATE_INFO_PATH]: { body: voiceValidateInfoFailed } });
      const result = await makeVoiceApi(fetchImpl).getValidationStatus(VOICE_VALIDATE_TASK_ID);
      expect(result).toEqual({ status: 'failed', failureReason: 'generation_failed' });
    });
  });

  describe('createVoice', () => {
    it('uploads the verification recording and submits it with the validation task id', async () => {
      const { fetchImpl, calls } = stubFetch({
        [UPLOAD_PATH]: { body: fileStreamUploadSuccess },
        [GENERATE_PATH]: { body: voiceGenerateSubmitSuccess },
      });
      const result = await makeVoiceApi(fetchImpl).createVoice({
        validationTaskId: VOICE_VALIDATE_TASK_ID,
        audio: AUDIO,
      });
      expect(result.providerTaskId).toBe(VOICE_CREATE_TASK_ID);
      expect(calls[0]!.url).toBe('https://sunoapiorg.redpandaai.co/api/file-stream-upload');
      expect(calls[1]!.body).toEqual({
        taskId: VOICE_VALIDATE_TASK_ID,
        verifyUrl: fileStreamUploadSuccess.data.downloadUrl,
        callBackUrl: CALLBACK_URL,
      });
    });
  });

  describe('getVoiceStatus', () => {
    it('reports processing while the voice id is absent', async () => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { body: voiceRecordInfoProcessing } });
      const result = await makeVoiceApi(fetchImpl).getVoiceStatus(VOICE_CREATE_TASK_ID);
      expect(result).toEqual({ status: 'processing' });
    });

    it('completes only after check-voice confirms the voice is usable', async () => {
      const { fetchImpl, calls } = stubFetch({
        [RECORD_INFO_PATH]: { body: voiceRecordInfoSuccess },
        [CHECK_VOICE_PATH]: { body: checkVoiceAvailable },
      });
      const result = await makeVoiceApi(fetchImpl).getVoiceStatus(VOICE_CREATE_TASK_ID);
      expect(result).toEqual({ status: 'complete', providerVoiceId: PROVIDER_VOICE_ID });
      const check = calls.find((call) => call.url.endsWith(CHECK_VOICE_PATH));
      expect(check?.method).toBe('POST');
      expect(check?.body).toEqual({ task_id: VOICE_CREATE_TASK_ID });
    });

    it('stays processing while the created voice is not yet usable for generation', async () => {
      // A voiceId in record-info is NOT readiness: generating against a voice
      // check-voice has not confirmed makes the provider silently ignore the
      // persona (generic vocals on a paid call).
      const { fetchImpl } = stubFetch({
        [RECORD_INFO_PATH]: { body: voiceRecordInfoSuccess },
        [CHECK_VOICE_PATH]: { body: checkVoiceUnavailable },
      });
      const result = await makeVoiceApi(fetchImpl).getVoiceStatus(VOICE_CREATE_TASK_ID);
      expect(result).toEqual({ status: 'processing' });
    });

    it('maps a credit failure to insufficient_credit', async () => {
      const { fetchImpl } = stubFetch({
        [RECORD_INFO_PATH]: { body: voiceRecordInfoInsufficientCredit },
      });
      const result = await makeVoiceApi(fetchImpl).getVoiceStatus(VOICE_CREATE_TASK_ID);
      expect(result).toEqual({ status: 'failed', failureReason: 'insufficient_credit' });
    });

    it('throws a sanitized error when the status call itself fails', async () => {
      const { fetchImpl } = stubFetch({ [RECORD_INFO_PATH]: { status: 500, body: {} } });
      await expect(makeVoiceApi(fetchImpl).getVoiceStatus(VOICE_CREATE_TASK_ID)).rejects.toThrow(
        'Could not read the voice setup status from the music provider.',
      );
    });
  });
});
