// Sanitized Suno API fixtures, DERIVED from live captures (one real generate ->
// poll -> credit run). Every real signed-URL host (`musicfile.removeai.ai`,
// `audiopipe.suno.ai`, `tempfile.aiquickdraw.com`, `cdn1.suno.ai`,
// `cdn2.suno.ai`) has been replaced with the placeholder host `*.example` — NO
// real signed URL is committed. The opaque `taskId` / track ids are kept verbatim
// so the shapes match the live API exactly.
//
// These feed an INJECTED fetch stub; no test ever touches the network (the suite
// costs zero real money).

export const SUNO_TASK_ID = '9137870119d47296c238423547783e15';

const TRACK_ID_A = '6ee24fe5-78bf-46da-b717-37d35ece5fb5';
const TRACK_ID_B = 'e047d526-c4ba-4a9c-ac42-e64666b4365e';

const TAGS = 'mellow lo-fi hip-hop study beat, swung drum pocket, Rhodes chords, soft, lo-fi';

/** Echoed-back request params Suno stores on the job (no secrets — the key lives in the header). */
const ECHOED_PARAM = JSON.stringify({
  callBackUrl: 'https://example.com/no-callback',
  customMode: false,
  instrumental: true,
  model: 'V4',
  prompt: 'A calm lo-fi instrumental study beat, mellow keys, soft vinyl crackle',
});

/** POST /api/v1/generate — submit acknowledgement (taskId must be persisted at once). */
export const submitSuccess = {
  code: 200,
  msg: 'success',
  data: { taskId: SUNO_TASK_ID },
};

/** A submit response with no taskId — the adapter must reject this (sanitized throw). */
export const submitMissingTaskId = {
  code: 200,
  msg: 'success',
  data: {},
};

/** A submit response the API marks as failed via `code`. */
export const submitErrorCode = {
  code: 429,
  msg: 'Insufficient credits',
  data: null,
};

// --- record-info shapes -----------------------------------------------------

/** A stream-only track (TEXT_SUCCESS / FIRST_SUCCESS pending sibling): no final audio yet. */
function streamOnlyTrack(id: string) {
  return {
    id,
    audioUrl: '', // empty until SUCCESS
    sourceAudioUrl: null,
    streamAudioUrl: `https://cdn.example/stream/${id}`,
    sourceStreamAudioUrl: `https://stream.example/?item_id=${id}`,
    imageUrl: `https://cdn.example/image/${id}.jpeg`,
    sourceImageUrl: `https://cdn.example/image_${id}.jpeg`,
    prompt: '[Instrumental]',
    modelName: 'chirp-auk-turbo',
    title: 'Paper Notes',
    tags: TAGS,
    createTime: 1782841189619,
    duration: null, // null until SUCCESS
  };
}

/** A finished track (SUCCESS): final audioUrl + duration populated. */
function finalTrack(id: string, duration: number) {
  return {
    id,
    audioUrl: `https://cdn.example/final/${id}.mp3`,
    sourceAudioUrl: `https://cdn.example/${id}.mp3`,
    streamAudioUrl: `https://cdn.example/stream/${id}`,
    sourceStreamAudioUrl: `https://cdn.example/${id}.mp3`,
    imageUrl: `https://cdn.example/image/${id}.jpeg`,
    sourceImageUrl: `https://cdn.example/image_${id}.jpeg`,
    prompt: '[Instrumental]',
    modelName: 'chirp-auk-turbo',
    title: 'Paper Notes',
    tags: TAGS,
    createTime: 1782841301663,
    duration,
  };
}

function recordInfoEnvelope(data: Record<string, unknown>) {
  return { code: 200, msg: 'success', data };
}

/** GET record-info — PENDING (response still null). */
export const recordInfoPending = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'PENDING',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: null,
  errorMessage: null,
  createTime: 1782841166000,
});

/** GET record-info — TEXT_SUCCESS: two stream-only sibling tracks, no final audio. */
export const recordInfoTextSuccess = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: {
    taskId: SUNO_TASK_ID,
    sunoData: [streamOnlyTrack(TRACK_ID_A), streamOnlyTrack(TRACK_ID_B)],
  },
  status: 'TEXT_SUCCESS',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: null,
  errorMessage: null,
  createTime: 1782841166000,
});

/** GET record-info — FIRST_SUCCESS: first track final, sibling still streaming. */
export const recordInfoFirstSuccess = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: {
    taskId: SUNO_TASK_ID,
    sunoData: [finalTrack(TRACK_ID_A, 168.08), streamOnlyTrack(TRACK_ID_B)],
  },
  status: 'FIRST_SUCCESS',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: null,
  errorMessage: null,
  createTime: 1782841166000,
});

/** GET record-info — SUCCESS: both tracks final (audioUrl + duration populated). */
export const recordInfoSuccess = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: {
    taskId: SUNO_TASK_ID,
    sunoData: [finalTrack(TRACK_ID_A, 168.08), finalTrack(TRACK_ID_B, 167.24)],
  },
  status: 'SUCCESS',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: null,
  errorMessage: null,
  createTime: 1782841166000,
});

/** GET record-info — GENERATE_AUDIO_FAILED -> generation_failed. */
export const recordInfoGenerateFailed = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'GENERATE_AUDIO_FAILED',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 500,
  errorMessage: 'Audio generation failed, please try again.',
  createTime: 1782841166000,
});

/** GET record-info — SENSITIVE_WORD_ERROR -> sensitive_content. */
export const recordInfoSensitiveWord = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'SENSITIVE_WORD_ERROR',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 400,
  errorMessage: 'The prompt contains sensitive words.',
  createTime: 1782841166000,
});

/** GET record-info — credit-exhausted failure -> insufficient_credit. */
export const recordInfoInsufficientCredit = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'CREATE_TASK_FAILED',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 429,
  errorMessage: 'Insufficient credits to start generation.',
  createTime: 1782841166000,
});

/** GET record-info — CREATE_TASK_FAILED (failure token in `status`) -> generation_failed. */
export const recordInfoCreateTaskFailed = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'CREATE_TASK_FAILED',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 500,
  errorMessage: 'Task creation failed.',
  createTime: 1782841166000,
});

/** GET record-info — CALLBACK_EXCEPTION (failure token in `status`) -> generation_failed. */
export const recordInfoCallbackException = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'CALLBACK_EXCEPTION',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 500,
  errorMessage: 'Callback delivery failed.',
  createTime: 1782841166000,
});

/**
 * GET record-info — a hard error carried in `errorCode`/`errorMessage` while the
 * `status` is STILL a progress token (TEXT_SUCCESS). Must map to failed even though
 * the status alone would read as `text_ready` — faithful regardless of WHERE Suno
 * puts the failure token. -> generation_failed.
 */
export const recordInfoErrorFieldGenerateFailed = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'TEXT_SUCCESS',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 'GENERATE_AUDIO_FAILED',
  errorMessage: 'Audio generation failed, please try again.',
  createTime: 1782841166000,
});

/**
 * GET record-info — insufficient credit signalled via `errorMessage` while `status`
 * is still PENDING. -> insufficient_credit.
 */
export const recordInfoErrorFieldInsufficientCredit = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'PENDING',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 429,
  errorMessage: 'Insufficient credits to start generation.',
  createTime: 1782841166000,
});

/** GET record-info — an unrecognized failure (no known token in any field) -> unknown. */
export const recordInfoUnknownFailure = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: 'SERVER_ERROR',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 500,
  errorMessage: 'Internal server error.',
  createTime: 1782841166000,
});

/**
 * GUARD fixture — a genuine SUCCESS whose error fields are present but EMPTY
 * (`errorCode: 0`, `errorMessage: ''`). The hard-error check must treat 0 / empty
 * as NOT-a-failure, so this still maps to `complete`, not `failed`.
 */
export const recordInfoSuccessEmptyError = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: {
    taskId: SUNO_TASK_ID,
    sunoData: [finalTrack(TRACK_ID_A, 168.08), finalTrack(TRACK_ID_B, 167.24)],
  },
  status: 'SUCCESS',
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: 0,
  errorMessage: '',
  createTime: 1782841166000,
});

/**
 * GET record-info — `code: 200` but `data` is null (observed when the read races
 * task creation). No status, no hard error: this is a failed status CALL (retryable
 * throw), NEVER a terminal failed job — the task is already paid for.
 */
export const recordInfoMissingData = { code: 200, msg: 'success', data: null };

/** Same race, with an empty `data` object instead of null. */
export const recordInfoMissingStatus = recordInfoEnvelope({
  taskId: SUNO_TASK_ID,
  parentMusicId: '',
  param: ECHOED_PARAM,
  response: null,
  status: null,
  type: 'chirp-auk-turbo',
  operationType: 'generate',
  errorCode: null,
  errorMessage: null,
  createTime: 1782841166000,
});

// --- timestamped lyrics -------------------------------------------------------

/** The sung lyric text of a VOCAL track (structure tags are part of the text). */
export const VOCAL_LYRICS = '[Verse]\nNeon rain on the window\n\n[Chorus]\nKeep the loop alive';

/** A finished VOCAL track: `prompt` carries the provider-written lyrics. */
export const finalVocalTrack = {
  ...finalTrack(TRACK_ID_A, 168.08),
  prompt: VOCAL_LYRICS,
};

/**
 * POST /api/v1/generate/get-timestamped-lyrics — success. Structure tags ride the
 * word stream with `success: false`; real words keep the provider's trailing
 * whitespace. `waveformData` is present but deliberately dropped by the adapter.
 */
export const timestampedLyricsSuccess = {
  code: 200,
  msg: 'success',
  data: {
    alignedWords: [
      { word: '[Verse]\n', success: false, startS: 0, endS: 0.4, palign: 0 },
      { word: 'Neon ', success: true, startS: 6.1, endS: 6.4, palign: 0 },
      { word: 'rain ', success: true, startS: 6.4, endS: 6.9, palign: 0 },
      { word: 'on the window\n', success: true, startS: 6.9, endS: 8.2, palign: 0 },
      { word: '[Chorus]\n', success: false, startS: 8.2, endS: 8.3, palign: 0 },
      { word: 'Keep the loop alive\n', success: true, startS: 12.5, endS: 15.1, palign: 0 },
    ],
    waveformData: [0, 0.4, 0.9, 0.4],
    hootCer: 0.05,
    isStreamed: false,
  },
};

/** Timestamped lyrics where the provider has nothing for the track. */
export const timestampedLyricsUnavailable = { code: 200, msg: 'success', data: null };

/** Timestamped-lyrics call rejected by the API envelope. */
export const timestampedLyricsErrorCode = { code: 400, msg: 'record not found', data: null };

// --- credit -----------------------------------------------------------------

/** GET /api/v1/generate/credit — `data` is the numeric balance. */
export const creditSuccess = { code: 200, msg: 'success', data: 1026.0 };

// --- voice profiles (custom user voice) --------------------------------------
// Shapes from the provider docs (checked 2026-07-22); no live captures yet — a
// founder-run smoke against a test account should confirm them before first use.

export const VOICE_VALIDATE_TASK_ID = 'voice-validate-task-1';
export const VOICE_CREATE_TASK_ID = 'voice-create-task-1';
export const PROVIDER_VOICE_ID = 'voice-id-abc123';
export const VERIFICATION_PHRASE = 'Harmonies fill the air with joyful melodies tonight';

/** POST /api/file-stream-upload — success (temporary 3-day retention). */
export const fileStreamUploadSuccess = {
  success: true,
  code: 200,
  msg: 'success',
  data: {
    fileName: 'voice.wav',
    filePath: 'liedmotif/voice-setup/voice.wav',
    downloadUrl: 'https://tempfile.example/token/liedmotif/voice-setup/voice.wav',
    fileSize: 123456,
    mimeType: 'audio/wav',
    uploadedAt: '2026-07-22T10:00:00Z',
  },
};

/** POST /api/file-stream-upload — rejected (no downloadUrl). */
export const fileStreamUploadFailure = {
  success: false,
  code: 500,
  msg: 'upload failed',
  data: null,
};

/** POST /api/v1/voice/validate — success. */
export const voiceValidateSubmitSuccess = {
  code: 200,
  msg: 'success',
  data: { taskId: VOICE_VALIDATE_TASK_ID },
};

/** GET /api/v1/voice/validate-info — still analyzing the source recording. */
export const voiceValidateInfoProcessing = {
  code: 200,
  msg: 'success',
  data: {
    taskId: VOICE_VALIDATE_TASK_ID,
    validateInfo: '',
    status: 'processing_validate',
    errorCode: null,
    errorMessage: null,
  },
};

/** GET /api/v1/voice/validate-info — phrase ready for the user to record. */
export const voiceValidateInfoReady = {
  code: 200,
  msg: 'success',
  data: {
    taskId: VOICE_VALIDATE_TASK_ID,
    validateInfo: VERIFICATION_PHRASE,
    status: 'wait_validating',
    errorCode: null,
    errorMessage: null,
  },
};

/** GET /api/v1/voice/validate-info — validation failed. */
export const voiceValidateInfoFailed = {
  code: 200,
  msg: 'success',
  data: {
    taskId: VOICE_VALIDATE_TASK_ID,
    validateInfo: '',
    status: 'processing_validate_fail',
    errorCode: 500,
    errorMessage: 'vocal segment too noisy',
  },
};

/** POST /api/v1/voice/check-voice — the created voice is usable for generation. */
export const checkVoiceAvailable = { code: 200, msg: 'success', data: { isAvailable: true } };

/** POST /api/v1/voice/check-voice — created but NOT yet usable for generation. */
export const checkVoiceUnavailable = { code: 200, msg: 'success', data: { isAvailable: false } };

/** POST /api/v1/voice/generate — success. */
export const voiceGenerateSubmitSuccess = {
  code: 200,
  msg: 'success',
  data: { taskId: VOICE_CREATE_TASK_ID },
};

/** GET /api/v1/voice/record-info — voice still being created. */
export const voiceRecordInfoProcessing = {
  code: 200,
  msg: 'success',
  data: {
    taskId: VOICE_CREATE_TASK_ID,
    voiceId: '',
    status: 'wait_processing',
    errorCode: null,
    errorMessage: null,
  },
};

/** GET /api/v1/voice/record-info — voice ready. */
export const voiceRecordInfoSuccess = {
  code: 200,
  msg: 'success',
  data: {
    taskId: VOICE_CREATE_TASK_ID,
    voiceId: PROVIDER_VOICE_ID,
    status: 'success',
    errorCode: null,
    errorMessage: null,
  },
};

/** GET /api/v1/voice/record-info — creation failed with a credit error. */
export const voiceRecordInfoInsufficientCredit = {
  code: 200,
  msg: 'success',
  data: {
    taskId: VOICE_CREATE_TASK_ID,
    voiceId: '',
    status: 'fail',
    errorCode: 402,
    errorMessage: 'insufficient credit balance',
  },
};

// --- lyrics (the user-voice generation prerequisite) --------------------------

export const LYRICS_TASK_ID = 'lyrics-task-1';
export const GENERATED_LYRICS = '[Verse]\nCity lights are calling\n[Chorus]\nWe run all night';

/** POST /api/v1/lyrics — success. */
export const lyricsSubmitSuccess = { code: 200, msg: 'success', data: { taskId: LYRICS_TASK_ID } };

/** GET /api/v1/lyrics/record-info — still writing. */
export const lyricsRecordInfoPending = {
  code: 200,
  msg: 'success',
  data: {
    taskId: LYRICS_TASK_ID,
    status: 'PENDING',
    response: null,
    errorCode: null,
    errorMessage: null,
  },
};

/** GET /api/v1/lyrics/record-info — success with two variants (first is used). */
export const lyricsRecordInfoSuccess = {
  code: 200,
  msg: 'success',
  data: {
    taskId: LYRICS_TASK_ID,
    status: 'SUCCESS',
    response: {
      taskId: LYRICS_TASK_ID,
      data: [
        { text: GENERATED_LYRICS, title: 'City Lights', status: 'complete', errorMessage: '' },
        {
          text: '[Verse]\nAnother take',
          title: 'Another Take',
          status: 'complete',
          errorMessage: '',
        },
      ],
    },
    errorCode: null,
    errorMessage: null,
  },
};

/** GET /api/v1/lyrics/record-info — the lyrics task failed. */
export const lyricsRecordInfoFailed = {
  code: 200,
  msg: 'success',
  data: {
    taskId: LYRICS_TASK_ID,
    status: 'GENERATE_LYRICS_FAILED',
    response: null,
    errorCode: 500,
    errorMessage: 'lyrics generation failed',
  },
};
