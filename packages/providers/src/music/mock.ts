// Mock music provider — for development and tests only, never user-facing. It
// implements the full MusicProvider contract deterministically and returns a local
// sample audio reference instead of spending real money, so the worker pipeline
// can be exercised end-to-end without a real music model. Suno is the only
// real music provider.

import { buildProviderDiagnostics, hash32 } from '@liedmotif/shared';
import type {
  GenerationCostEstimate,
  MusicGenerationInput,
  MusicGenerationStatusResult,
  MusicGenerationTask,
  MusicProvider,
  MusicProviderCapabilities,
  NormalizedTrack,
  TimedLyrics,
  TimedLyricWord,
} from './index';

export const MOCK_MUSIC_CAPABILITIES: MusicProviderCapabilities = {
  generationModes: ['non_custom', 'custom'],
  supportsInstrumental: true,
  supportsVocals: true,
  supportsCustomTitle: true,
  supportsStylePrompt: true,
  supportsNegativePrompt: true,
  supportsContinuation: true,
  supportsStreamUrl: true,
  supportsFinalAudioUrl: true,
  typicalTracksPerRequest: 2,
  expectedStreamLatencySeconds: [0, 1],
  expectedFinalLatencySeconds: [0, 1],
  modelOptions: ['mock-v1'],
  maxStyleLength: 1000,
  maxTitleLength: 80,
  maxPromptLength: 2000,
  providerRetentionNote: 'Mock provider — returns sample audio; no real retention.',
  customVoice: {
    supported: true,
    maxVoicesPerGeneration: 1,
    requiresVerificationPhrase: true,
    supportedModels: ['mock-v1'],
  },
};

/** Deterministic mock voice-setup fixtures (instant completion, no network). */
export const MOCK_VERIFICATION_PHRASE = 'Harmonies fill the air with joyful melodies tonight';
export const MOCK_PROVIDER_VOICE_ID = 'mock-voice-1';

const DEFAULT_SAMPLE_AUDIO_URL = 'file:///data/samples/mock-track.mp3';
const DEFAULT_SAMPLE_STREAM_URL = 'file:///data/samples/mock-track.stream.mp3';

/** Fixed lyric text (with section tags, like Suno's) so the lyrics UI is exercisable. */
const MOCK_LYRICS_LINES = [
  '[Verse]',
  'Neon rain on the window glass',
  'Code still humming after midnight',
  '[Chorus]',
  'Keep the loop alive',
  'Let the beat decide',
];
const MOCK_LYRICS = MOCK_LYRICS_LINES.join('\n');

export interface MockMusicOptions {
  /** Final downloadable audio reference returned for every generated track. */
  sampleAudioUrl?: string;
  /** Early stream reference — distinct from the final so the cold-start swap is testable. */
  sampleStreamUrl?: string;
}

export function mockMusicProvider(options: MockMusicOptions = {}): MusicProvider {
  const sampleAudioUrl = options.sampleAudioUrl ?? DEFAULT_SAMPLE_AUDIO_URL;
  const sampleStreamUrl = options.sampleStreamUrl ?? DEFAULT_SAMPLE_STREAM_URL;
  const model = 'mock-v1';

  function taskIdFor(input: MusicGenerationInput): string {
    return `mock-${hash32(`${input.prompt}#${input.seed ?? 0}`)}`;
  }

  function tracksFor(taskId: string): NormalizedTrack[] {
    return [0, 1].map((index) => ({
      providerTrackId: `${taskId}-${index}`,
      title: `Mock Track ${index + 1}`,
      streamAudioUrl: sampleStreamUrl,
      audioUrl: sampleAudioUrl,
      durationSeconds: 120,
      model,
      lyrics: MOCK_LYRICS,
    }));
  }

  return {
    providerType: 'music',
    providerKey: 'mock',

    getCapabilities() {
      return MOCK_MUSIC_CAPABILITIES;
    },

    // Instant-success voice setup so the whole Settings workflow is exercisable
    // without a real provider (statuses complete on the first poll).
    voice: {
      async validateSource(input) {
        return { providerTaskId: `mock-voice-validate-${hash32(input.audio.fileName)}` };
      },
      async getValidationStatus() {
        return { status: 'complete', verificationPhrase: MOCK_VERIFICATION_PHRASE };
      },
      async createVoice(input) {
        return { providerTaskId: `mock-voice-create-${hash32(input.validationTaskId)}` };
      },
      async getVoiceStatus() {
        return { status: 'complete', providerVoiceId: MOCK_PROVIDER_VOICE_ID };
      },
    },

    async validateCredentials() {
      return { ok: true, message: 'Mock provider needs no credentials.' };
    },

    estimateGenerationCost(_input: MusicGenerationInput): GenerationCostEstimate {
      const providerCalls = 1;
      return {
        providerCalls,
        expectedTracks: providerCalls * MOCK_MUSIC_CAPABILITIES.typicalTracksPerRequest,
      };
    },

    async createGenerationTask(input: MusicGenerationInput): Promise<MusicGenerationTask> {
      return {
        providerTaskId: taskIdFor(input),
        status: 'pending',
        provider: { providerType: 'music', providerKey: 'mock', model: input.model ?? model },
        diagnostics: buildProviderDiagnostics({
          rawRequest: { mode: input.mode, prompt: input.prompt, style: input.style },
        }),
      };
    },

    async getGenerationStatus(providerTaskId: string): Promise<MusicGenerationStatusResult> {
      return {
        status: 'complete',
        tracks: tracksFor(providerTaskId),
        provider: { providerType: 'music', providerKey: 'mock', model },
      };
    },

    normalizeProviderTrack(raw: unknown): NormalizedTrack {
      const track = (raw ?? {}) as Partial<NormalizedTrack>;
      return {
        providerTrackId: String(track.providerTrackId ?? ''),
        ...(track.title !== undefined ? { title: track.title } : {}),
        ...(track.streamAudioUrl !== undefined ? { streamAudioUrl: track.streamAudioUrl } : {}),
        ...(track.audioUrl !== undefined ? { audioUrl: track.audioUrl } : {}),
        ...(track.durationSeconds !== undefined ? { durationSeconds: track.durationSeconds } : {}),
        ...(track.model !== undefined ? { model: track.model } : {}),
        ...(track.lyrics !== undefined ? { lyrics: track.lyrics } : {}),
      };
    },

    async getTimestampedLyrics(): Promise<TimedLyrics | null> {
      // One word entry per lyric line (line-grained timing is plenty for dev):
      // section tags are unaligned filler, sung lines advance a fixed cadence.
      let cursor = 2;
      const words: TimedLyricWord[] = MOCK_LYRICS_LINES.map((line) => {
        const isTag = line.startsWith('[');
        const start = cursor;
        const end = start + (isTag ? 0.2 : 2.5);
        if (!isTag) cursor = end + 0.5;
        return { word: `${line}\n`, startSeconds: start, endSeconds: end, success: !isTag };
      });
      return { words, alignmentErrorScore: 0.02 };
    },
  };
}
