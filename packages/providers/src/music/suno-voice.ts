// Suno voice-profile workflow (the `MusicVoiceApi` implementation): deliver a
// recording to the provider, validate it, read the verification phrase, create
// the voice, and poll for the resulting `voiceId`. This file owns ALL Suno
// voice wire knowledge, mirroring `suno.ts` for generation.
//
// Delivery: the voice endpoints take provider-fetchable HTTPS URLs, so each
// recording is first pushed server-to-server through Suno's temporary
// File Stream Upload (3-day retention) and its `downloadUrl` is used
// immediately — never returned, logged, or persisted. Liedmotif storage stays
// the authoritative copy; no Liedmotif URL ever reaches the provider. The
// upload service runs on its own vendor host (`sunoapiorg.redpandaai.co`),
// separate from the configurable API base URL.
//
// Security rules match `suno.ts`: Bearer key only in headers, SSRF-gated base
// URL, time-bounded requests, and every failure throws a SANITIZED
// `ProviderError` — never the raw provider body or a temporary URL.

import { ProviderError } from '../errors';
import { assertAllowedBaseUrl } from '../validation/ssrf';
import {
  isSunoEnvelope,
  nonEmptyString,
  SUNO_DEFAULT_BASE_URL,
  sunoAuthHeaders,
  sunoEnvelopeTaskId,
  sunoFetchJson,
} from './suno-wire';
import type {
  MusicFailureReason,
  MusicVoiceApi,
  VoiceAudioSource,
  VoiceCreationStatusResult,
  VoiceValidationStatusResult,
} from './index';

/**
 * Generation models that actually HONOR `personaModel: 'voice_persona'`.
 * Suno's own Voices FAQ is authoritative here: only v5.5 supports cloned
 * voices — "Other models do not support the New Voices feature." The
 * aggregator's docs also list V5, but a V5 generation ACCEPTS the persona
 * fields and silently sings with a generic voice (verified live 2026-07-22),
 * which is exactly the silent fallback the own-voice contract forbids.
 */
export const SUNO_VOICE_PERSONA_MODELS = ['V5_5'];

export interface SunoVoiceConfig {
  apiKey: string;
  callbackUrl: string;
  fetch: typeof globalThis.fetch;
  requestTimeoutMs: number;
  /** Upload timeout — recordings are megabytes, so it exceeds the JSON timeout. */
  uploadTimeoutMs?: number;
}

const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The File Stream Upload API's own host (provider docs) — it does NOT exist on
 * the main API base URL, so the configurable `baseUrl` never applies here.
 */
const SUNO_UPLOAD_BASE_URL = 'https://sunoapiorg.redpandaai.co';

/** Provider directory for temporary voice uploads (a namespace, not a secret). */
const UPLOAD_PATH = 'liedmotif/voice-setup';

// Sanitized, fixed user/log-safe messages (never built from a provider response).
const VOICE_DELIVERY_FAILED = 'Could not deliver the recording to the music provider.';
const VOICE_SUBMIT_FAILED = 'The music provider rejected the voice request.';
const VOICE_STATUS_FAILED = 'Could not read the voice setup status from the music provider.';

/**
 * Voice-task statuses that mean the task itself failed. The same status vocabulary
 * serves validate-info and record-info (provider docs, checked 2026-07-22).
 */
const VOICE_TASK_FAILURES = ['fail', 'processing_validate_fail'];

interface SunoVoiceTaskData {
  status?: unknown;
  validateInfo?: unknown;
  voiceId?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}

/** Map a failed voice task to a sanitized reason (field-agnostic, like generation). */
function mapVoiceFailureReason(data: SunoVoiceTaskData): MusicFailureReason {
  const blob =
    `${data.status ?? ''} ${data.errorCode ?? ''} ${data.errorMessage ?? ''}`.toLowerCase();
  if (blob.includes('credit')) return 'insufficient_credit';
  if (blob.includes('sensitive')) return 'sensitive_content';
  return 'generation_failed';
}

export function createSunoVoiceApi(config: SunoVoiceConfig): MusicVoiceApi {
  const { apiKey, callbackUrl } = config;
  const baseUrl = SUNO_DEFAULT_BASE_URL;
  const fetchImpl = config.fetch;
  const uploadTimeoutMs = config.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    return sunoAuthHeaders(apiKey, extra);
  }

  /**
   * Push one recording to the provider's temporary file service and return its
   * fetchable URL. The URL is handed straight to the next provider call and
   * then dropped — callers must never surface it.
   */
  async function uploadRecording(audio: VoiceAudioSource): Promise<string> {
    assertAllowedBaseUrl('suno', SUNO_UPLOAD_BASE_URL);
    const form = new FormData();
    // Copied into a fresh view so the Blob is typed over a plain ArrayBuffer.
    form.set(
      'file',
      new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }),
      audio.fileName,
    );
    form.set('uploadPath', UPLOAD_PATH);
    form.set('fileName', audio.fileName);
    const result = await sunoFetchJson(
      fetchImpl,
      `${SUNO_UPLOAD_BASE_URL}/api/file-stream-upload`,
      // No explicit content-type: fetch writes the multipart boundary itself.
      { method: 'POST', headers: authHeaders(), body: form, redirect: 'manual' },
      uploadTimeoutMs,
    );
    if (!result.ok) throw new ProviderError(VOICE_DELIVERY_FAILED);
    const payload = result.payload as { data?: { downloadUrl?: unknown } };
    const downloadUrl = nonEmptyString(payload?.data?.downloadUrl);
    if (!downloadUrl) throw new ProviderError(VOICE_DELIVERY_FAILED);
    return downloadUrl;
  }

  /** Submit one JSON voice call and return the envelope task id (code 200 only). */
  async function submitVoiceTask(path: string, body: Record<string, unknown>): Promise<string> {
    assertAllowedBaseUrl('suno', baseUrl);
    const result = await sunoFetchJson(
      fetchImpl,
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        redirect: 'manual',
      },
      config.requestTimeoutMs,
    );
    if (!result.ok) throw new ProviderError(VOICE_SUBMIT_FAILED);
    const payload = result.payload;
    if (!isSunoEnvelope(payload) || payload.code !== 200) {
      throw new ProviderError(VOICE_SUBMIT_FAILED);
    }
    const taskId = sunoEnvelopeTaskId(payload);
    if (!taskId) throw new ProviderError(VOICE_SUBMIT_FAILED);
    return taskId;
  }

  /** Read one voice-task status payload (validate-info / record-info). */
  async function fetchVoiceTask(path: string, providerTaskId: string): Promise<SunoVoiceTaskData> {
    assertAllowedBaseUrl('suno', baseUrl);
    const url = `${baseUrl}${path}?taskId=${encodeURIComponent(providerTaskId)}`;
    const result = await sunoFetchJson(
      fetchImpl,
      url,
      { method: 'GET', headers: authHeaders(), redirect: 'manual' },
      config.requestTimeoutMs,
    );
    if (!result.ok) throw new ProviderError(VOICE_STATUS_FAILED);
    const payload = result.payload;
    if (!isSunoEnvelope(payload) || payload.code !== 200) {
      throw new ProviderError(VOICE_STATUS_FAILED);
    }
    return (payload.data ?? {}) as SunoVoiceTaskData;
  }

  /** Whether a voice-task payload reports a failed task (status or error fields). */
  function isFailedTask(data: SunoVoiceTaskData): boolean {
    const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
    if (VOICE_TASK_FAILURES.includes(status)) return true;
    return nonEmptyString(data.errorMessage) !== undefined;
  }

  /**
   * Whether the created voice is usable for generation (`check-voice`). A
   * `voiceId` in record-info is NOT readiness — generating against a voice the
   * provider has not made available yet silently yields generic vocals on a
   * paid call, so completion requires this confirmation.
   */
  async function isVoiceAvailable(providerTaskId: string): Promise<boolean> {
    assertAllowedBaseUrl('suno', baseUrl);
    const result = await sunoFetchJson(
      fetchImpl,
      `${baseUrl}/api/v1/voice/check-voice`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ task_id: providerTaskId }),
        redirect: 'manual',
      },
      config.requestTimeoutMs,
    );
    if (!result.ok) throw new ProviderError(VOICE_STATUS_FAILED);
    const payload = result.payload;
    if (!isSunoEnvelope(payload) || payload.code !== 200) {
      throw new ProviderError(VOICE_STATUS_FAILED);
    }
    const data = (payload.data ?? {}) as { isAvailable?: unknown };
    return data.isAvailable === true;
  }

  return {
    async validateSource(input) {
      const voiceUrl = await uploadRecording(input.audio);
      return {
        providerTaskId: await submitVoiceTask('/api/v1/voice/validate', {
          voiceUrl,
          vocalStartS: input.vocalStartS,
          vocalEndS: input.vocalEndS,
          ...(input.language ? { language: input.language } : {}),
          callBackUrl: callbackUrl,
        }),
      };
    },

    async getValidationStatus(providerTaskId): Promise<VoiceValidationStatusResult> {
      const data = await fetchVoiceTask('/api/v1/voice/validate-info', providerTaskId);
      if (isFailedTask(data)) {
        return { status: 'failed', failureReason: mapVoiceFailureReason(data) };
      }
      // Data-driven completion: the phrase itself is what the caller needs, so
      // its presence — not a particular status token — is the "complete" signal.
      const verificationPhrase = nonEmptyString(data.validateInfo);
      return verificationPhrase
        ? { status: 'complete', verificationPhrase }
        : { status: 'processing' };
    },

    async createVoice(input) {
      const verifyUrl = await uploadRecording(input.audio);
      return {
        providerTaskId: await submitVoiceTask('/api/v1/voice/generate', {
          taskId: input.validationTaskId,
          verifyUrl,
          callBackUrl: callbackUrl,
        }),
      };
    },

    async getVoiceStatus(providerTaskId): Promise<VoiceCreationStatusResult> {
      const data = await fetchVoiceTask('/api/v1/voice/record-info', providerTaskId);
      if (isFailedTask(data)) {
        return { status: 'failed', failureReason: mapVoiceFailureReason(data) };
      }
      // Like validation, the presence of the voice reference is the completion
      // signal — never a status token alone — and completion additionally
      // requires the provider's usable-for-generation confirmation.
      const providerVoiceId = nonEmptyString(data.voiceId);
      if (!providerVoiceId) return { status: 'processing' };
      return (await isVoiceAvailable(providerTaskId))
        ? { status: 'complete', providerVoiceId }
        : { status: 'processing' };
    },
  };
}
