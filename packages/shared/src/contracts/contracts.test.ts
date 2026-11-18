import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_CONTRACTS,
  API_ENDPOINT_NAMES,
  API_ERROR_CODES,
  COVER_STYLE_CHOICES,
  COVER_STYLES,
  DEFAULT_NOVELTY,
  DEFAULT_STYLE_STRENGTH,
  MAX_SESSION_AVOID_LENGTH,
  PERSISTED_PLAYBACK_EVENT_TYPES,
  PLAYBACK_REPORT_TYPES,
  apiResponse,
  changeVibeIntentInputSchema,
  changeVibeRequestSchema,
  dislikeTrackResponseSchema,
  errorResponseSchema,
  getDiagnosticsResponseSchema,
  getSessionQueueResponseSchema,
  getTrackResponseSchema,
  listSessionsRequestSchema,
  listSessionsResponseSchema,
  libraryTrackItemSchema,
  makeApiError,
  moreLikeThisResponseSchema,
  sessionIntentInputSchema,
  sessionListItemSchema,
  reportPlaybackStateRequestSchema,
  resumeSessionRequestSchema,
  resumeSessionResponseSchema,
  sendFeedbackRequestSchema,
  sessionSummarySchema,
  setSessionModeRequestSchema,
  setSessionModeResponseSchema,
  startSessionRequestSchema,
  startSessionResponseSchema,
  trackSummarySchema,
  type ApiEndpointName,
} from './index';
import { SESSION_MODES } from '../state-machines/literals';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const ISO = '2026-06-28T10:00:00Z';

/** One valid `sessionSummarySchema` payload, reused across the session contracts. */
const VALID_SESSION_SUMMARY = {
  id: UUID,
  status: 'active',
  title: null,
  createdAt: ISO,
  updatedAt: ISO,
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
};

/** One minimal VALID request body per endpoint, used for the cross-cutting checks. */
const VALID_REQUESTS: Record<ApiEndpointName, unknown> = {
  startSession: { input: { mode: 'prompt', prompt: 'lofi beats' }, clientId: 'phone-1' },
  stopSession: { sessionId: UUID },
  deleteSession: { sessionId: UUID },
  convertSessionToPlaylist: { sessionId: UUID },
  renameSession: { sessionId: UUID, title: 'Late Night Focus' },
  setSessionMode: { sessionId: UUID, mode: 'repeat' },
  setSessionDuration: { sessionId: UUID, targetDurationMinutes: null, sessionMode: 'keep_going' },
  resumeSession: { sessionId: UUID, clientId: 'phone-1' },
  playSessionTrack: { sessionId: UUID, trackId: UUID, clientId: 'phone-1' },
  changeVibe: { sessionId: UUID, input: { mode: 'controls', controls: { energy: 'low' } } },
  moreLikeThis: { seedTrackIds: [UUID], clientId: 'phone-1' },
  getSessionQueue: { sessionId: UUID },
  regenerateSessionCover: { activitySessionId: UUID },
  sessionCoverStatus: { activitySessionId: UUID },
  selectSessionCover: { activitySessionId: UUID, coverImageId: UUID },
  deleteSessionCover: { activitySessionId: UUID, coverImageId: UUID },
  reportPlaybackState: {
    sessionId: UUID,
    clientId: 'phone-1',
    clientEventId: UUID,
    type: 'position',
    queueItemId: null,
    trackId: UUID,
    positionSeconds: 12.5,
    clientTimestamp: ISO,
  },
  saveTrack: { trackId: UUID, saved: false },
  favoriteTrack: { trackId: UUID, favorited: true },
  dislikeTrack: { trackId: UUID },
  deleteTrack: { trackId: UUID },
  renameTrack: { trackId: UUID, title: 'Midnight Run' },
  sendFeedback: { trackId: UUID, sessionId: null, type: 'skip', value: null, freeformText: null },
  getLibrary: { view: 'saved', cursor: null, limit: 20 },
  listPlaylists: { trackId: UUID },
  createPlaylist: { name: 'Deep Work Winners' },
  renamePlaylist: { playlistId: UUID, name: 'Deep Work Winners' },
  deletePlaylist: { playlistId: UUID },
  markPlaylistPlayed: { playlistId: UUID },
  getPlaylist: { playlistId: UUID, cursor: null, limit: 200 },
  addPlaylistTracks: { playlistId: UUID, trackIds: [UUID] },
  removePlaylistTrack: { playlistId: UUID, trackId: UUID },
  setPlaylistOrder: { playlistId: UUID, trackIds: [UUID] },
  applyTrackMemberships: { trackId: UUID, playlistIds: [UUID], createPlaylistName: null },
  regeneratePlaylistCover: { playlistId: UUID, guidance: 'sunset over vinyl' },
  playlistCoverStatus: { playlistId: UUID },
  selectPlaylistCover: { playlistId: UUID, coverImageId: UUID },
  deletePlaylistCover: { playlistId: UUID, coverImageId: UUID },
  listSessions: { cursor: null, limit: 20 },
  search: { q: 'rainy run' },
  getDiagnostics: {},
  getChrome: {},
  validateProvider: { providerType: 'music', providerKey: 'suno' },
};

describe('API_CONTRACTS registry', () => {
  it('declares exactly the named endpoints', () => {
    expect(API_ENDPOINT_NAMES).toHaveLength(43);
    expect(Object.keys(API_CONTRACTS).sort()).toEqual([...API_ENDPOINT_NAMES].sort());
  });

  it('marks every endpoint admin in the registry', () => {
    for (const name of API_ENDPOINT_NAMES) {
      expect(API_CONTRACTS[name].auth).toBe('admin');
    }
  });

  it('documents a retry policy for every endpoint', () => {
    for (const name of API_ENDPOINT_NAMES) {
      const { retry } = API_CONTRACTS[name];
      expect(typeof retry.retryable).toBe('boolean');
      expect(typeof retry.idempotent).toBe('boolean');
      expect(retry.note.length).toBeGreaterThan(0);
    }
  });

  it('does not advertise the mutating create actions as client-retryable', () => {
    // These may submit paid provider jobs; only the server guards money-idempotency.
    for (const name of ['startSession', 'moreLikeThis', 'changeVibe'] as const) {
      expect(API_CONTRACTS[name].retry.retryable).toBe(false);
    }
  });
});

describe('request schemas — valid / extra / missing', () => {
  for (const name of API_ENDPOINT_NAMES) {
    it(`${name}: accepts a valid body, rejects an extra key`, () => {
      const schema = API_CONTRACTS[name].request;
      const valid = VALID_REQUESTS[name];
      expect(schema.safeParse(valid).success).toBe(true);
      // Strict objects reject unknown keys → client/server can't drift on names.
      expect(schema.safeParse({ ...(valid as object), __extra: true }).success).toBe(false);
    });
  }

  it('startSession rejects a missing required field', () => {
    expect(
      startSessionRequestSchema.safeParse({ input: { mode: 'prompt', prompt: 'x' } }).success,
    ).toBe(false); // clientId missing
  });

  it('startSession accepts the Custom cover-style choice (last in the choice list)', () => {
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x' },
        clientId: 'c',
        coverStyle: 'custom',
      }).success,
    ).toBe(true);
    // The create-card dropdown renders the choices in order: Auto first, Custom last.
    expect(COVER_STYLE_CHOICES[0]).toBe('auto');
    expect(COVER_STYLE_CHOICES[COVER_STYLE_CHOICES.length - 1]).toBe('custom');
  });

  it('startSession accepts the choice-only Random cover style (never persisted)', () => {
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x' },
        clientId: 'c',
        coverStyle: 'random',
      }).success,
    ).toBe(true);
    // Random is offered on the create card but resolves to a persisted style,
    // so it never appears in the persisted vocabulary.
    expect(COVER_STYLES).not.toContain('random');
  });

  it('startSession accepts the skip-profile flag as an optional boolean', () => {
    const base = { input: { mode: 'prompt', prompt: 'x' }, clientId: 'c' };
    expect(startSessionRequestSchema.safeParse({ ...base, skipProfile: true }).success).toBe(true);
    expect(startSessionRequestSchema.safeParse(base).success).toBe(true);
    expect(startSessionRequestSchema.safeParse({ ...base, skipProfile: 'yes' }).success).toBe(
      false,
    );
  });

  it('startSession accepts up to 3 explicit genre picks on a free-text intent', () => {
    // The describe-tab fine-tune picks ride the prompt intent so the words alone
    // don't have to name the genre. Empty picks stay representable as omission.
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'rainy night drive', genres: ['techno', 'ambient'] },
        clientId: 'c',
      }).success,
    ).toBe(true);
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x', genres: ['a', 'b', 'c', 'd'] },
        clientId: 'c',
      }).success,
    ).toBe(false); // over the 3-pick cap
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x', genres: [''] },
        clientId: 'c',
      }).success,
    ).toBe(false); // a pick must be a non-empty tag
  });

  it('startSession accepts energy, vocal, and voice picks on a free-text intent', () => {
    // The describe-tab fine-tune picks ride the prompt intent; Auto/Any stay
    // representable as omission, and out-of-vocabulary values are rejected.
    expect(
      startSessionRequestSchema.safeParse({
        input: {
          mode: 'prompt',
          prompt: 'rainy night drive',
          energy: 'high',
          vocal: 'vocal',
          voice: 'female',
        },
        clientId: 'c',
      }).success,
    ).toBe(true);
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x', energy: 'auto' },
        clientId: 'c',
      }).success,
    ).toBe(false);
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x', vocal: 'auto' },
        clientId: 'c',
      }).success,
    ).toBe(false);
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: 'x', voice: 'any' },
        clientId: 'c',
      }).success,
    ).toBe(false);
  });

  it('startSession accepts a voice pick on structured controls', () => {
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'controls', controls: { vocal: 'vocal', voice: 'male' } },
        clientId: 'c',
      }).success,
    ).toBe(true);
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'controls', controls: { vocal: 'vocal', voice: 'robot' } },
        clientId: 'c',
      }).success,
    ).toBe(false);
  });

  it('changeVibe accepts explicit fine-tune picks on the prompt branch', () => {
    for (const picks of [
      { genres: ['techno'] },
      { energy: 'high' },
      { vocal: 'vocal' },
      { voice: 'female' },
      { language: 'German' },
    ]) {
      expect(
        changeVibeRequestSchema.safeParse({
          sessionId: UUID,
          input: { mode: 'prompt', prompt: 'slower and darker', ...picks },
        }).success,
      ).toBe(true);
    }
    expect(
      changeVibeRequestSchema.safeParse({
        sessionId: UUID,
        input: { mode: 'prompt', prompt: 'slower and darker' },
      }).success,
    ).toBe(true);
    // Still strict: unknown pick keys and off-list values are rejected.
    expect(
      changeVibeRequestSchema.safeParse({
        sessionId: UUID,
        input: { mode: 'prompt', prompt: 'slower', tempo: 'fast' },
      }).success,
    ).toBe(false);
    expect(
      changeVibeRequestSchema.safeParse({
        sessionId: UUID,
        input: { mode: 'prompt', prompt: 'slower', language: 'Klingon' },
      }).success,
    ).toBe(false);
  });

  it('changeVibe carries the switch-now choice as an optional boolean', () => {
    expect(
      changeVibeRequestSchema.safeParse({
        sessionId: UUID,
        input: { mode: 'prompt', prompt: 'slower' },
        switchImmediately: true,
      }).success,
    ).toBe(true);
    expect(
      changeVibeRequestSchema.safeParse({
        sessionId: UUID,
        input: { mode: 'prompt', prompt: 'slower' },
        switchImmediately: 'yes',
      }).success,
    ).toBe(false);
  });

  it('startSession rejects an unknown create mode and an empty prompt', () => {
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'voice', prompt: 'x' },
        clientId: 'c',
      }).success,
    ).toBe(false);
    expect(
      startSessionRequestSchema.safeParse({
        input: { mode: 'prompt', prompt: '' },
        clientId: 'c',
      }).success,
    ).toBe(false);
  });
});

describe('reportPlaybackState idempotency key', () => {
  it('requires a clientEventId so persisted-event retries can be deduped', () => {
    const valid = VALID_REQUESTS.reportPlaybackState as Record<string, unknown>;
    const { clientEventId: _omitted, ...withoutKey } = valid;
    expect(reportPlaybackStateRequestSchema.safeParse(withoutKey).success).toBe(false);
    expect(reportPlaybackStateRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('marks reportPlaybackState idempotent (the key makes retries safe)', () => {
    expect(API_CONTRACTS.reportPlaybackState.retry.idempotent).toBe(true);
  });
});

describe('playback report types (position is live-only)', () => {
  it('the report set is the persisted set plus the live-only `position`', () => {
    for (const persisted of PERSISTED_PLAYBACK_EVENT_TYPES) {
      expect(PLAYBACK_REPORT_TYPES).toContain(persisted);
    }
    expect(PLAYBACK_REPORT_TYPES).toContain('position');
    expect(PERSISTED_PLAYBACK_EVENT_TYPES).not.toContain('position');
  });
});

describe('feedback model', () => {
  it('has no `like` feedback type', () => {
    expect(
      sendFeedbackRequestSchema.safeParse({
        trackId: UUID,
        sessionId: null,
        type: 'like',
        value: null,
        freeformText: null,
      }).success,
    ).toBe(false);
  });

  it('accepts the soft-negative skip and the dislike/retention types', () => {
    for (const type of ['skip', 'dislike', 'save', 'unsave', 'favorite', 'unfavorite']) {
      expect(
        sendFeedbackRequestSchema.safeParse({
          trackId: UUID,
          sessionId: null,
          type,
          value: null,
          freeformText: null,
        }).success,
      ).toBe(true);
    }
  });

  it('dislike response models the reroll (sibling vs fresh generation)', () => {
    const ok = dislikeTrackResponseSchema.safeParse({
      ok: true,
      data: { trackId: UUID, dislikedAt: ISO, rerollQueued: true, replacementSource: 'sibling' },
    });
    expect(ok.success).toBe(true);
  });
});

describe('Session guardrails ride every intent branch', () => {
  /** Every shape a guardrail must survive: both create branches and Change Vibe
   *  (which reuses the create intent), so a fold rendered on one tab can never
   *  have its values silently rejected by the strict object on another. */
  const withGuardrails = (guardrails: Record<string, unknown>) => [
    sessionIntentInputSchema.safeParse({ mode: 'prompt', prompt: 'lofi beats', ...guardrails }),
    sessionIntentInputSchema.safeParse({ mode: 'controls', controls: { ...guardrails } }),
    changeVibeIntentInputSchema.safeParse({ mode: 'prompt', prompt: 'warmer', ...guardrails }),
  ];

  it('accepts the three guardrails on both create branches and on Change Vibe', () => {
    for (const parsed of withGuardrails({
      styleStrength: DEFAULT_STYLE_STRENGTH,
      novelty: DEFAULT_NOVELTY,
      avoid: 'saxophone, brass',
    })) {
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts the 0 and 1 ends of the slider range and rejects anything outside it', () => {
    for (const level of [0, 1]) {
      for (const parsed of withGuardrails({ styleStrength: level, novelty: level })) {
        expect(parsed.success).toBe(true);
      }
    }
    for (const level of [-0.01, 1.01]) {
      for (const parsed of withGuardrails({ styleStrength: level })) {
        expect(parsed.success).toBe(false);
      }
      for (const parsed of withGuardrails({ novelty: level })) {
        expect(parsed.success).toBe(false);
      }
    }
  });

  it('rejects avoid text over the length bound', () => {
    for (const parsed of withGuardrails({ avoid: 'x'.repeat(MAX_SESSION_AVOID_LENGTH) })) {
      expect(parsed.success).toBe(true);
    }
    for (const parsed of withGuardrails({ avoid: 'x'.repeat(MAX_SESSION_AVOID_LENGTH + 1) })) {
      expect(parsed.success).toBe(false);
    }
  });
});

describe('diagnostics & queue expose generation-controller state', () => {
  const diagnosticsData = {
    worker: {
      heartbeatAt: ISO,
      stale: false,
      state: 'ready',
      concurrency: 2,
      jobsInFlight: 1,
      queuedJobs: 2,
      failedJobs: 0,
      lastProviderPoll: { status: 'FIRST_SUCCESS', at: ISO },
      retriesToday: 1,
      events: [
        { at: ISO, level: 'warn', message: 'generate a1b2c3d4 failed · GENERATE_AUDIO_FAILED' },
      ],
    },
    providers: [],
    usage: {
      dailyTracksUsed: 0,
      dailyTracksLimit: 40,
      monthlyTracksUsed: 0,
      monthlyTracksLimit: 400,
      minHeadroomTracksToStartSession: 5,
      budgetKind: 'rolling',
    },
  };
  const queueData = {
    sessionId: UUID,
    sessionStatus: 'active',
    coverImageId: null,
    styleRevision: 1,
    currentTrackId: null,
    currentQueueItemId: null,
    earlierTracks: 0,
    items: [],
    generatingTracksAhead: 0,
    generatingNewVibeTracksAhead: 0,
    pendingGeneration: null,
    vibe: null,
    switchPending: false,
    tryAgainTracks: 2,
  };

  it('getDiagnostics activeSession carries the full controller-aware summary (or null)', () => {
    // A degraded generationStatus rides alongside an `active` lifecycle status.
    expect(
      getDiagnosticsResponseSchema.safeParse({
        ok: true,
        data: {
          ...diagnosticsData,
          activeSession: { ...VALID_SESSION_SUMMARY, generationStatus: 'repeat_cost_limit' },
        },
      }).success,
    ).toBe(true);
    // No active session is valid.
    expect(
      getDiagnosticsResponseSchema.safeParse({
        ok: true,
        data: { ...diagnosticsData, activeSession: null },
      }).success,
    ).toBe(true);
    // The old bare `{ id, status }` activeSession no longer suffices (no controller state).
    expect(
      getDiagnosticsResponseSchema.safeParse({
        ok: true,
        data: { ...diagnosticsData, activeSession: { id: UUID, status: 'active' } },
      }).success,
    ).toBe(false);
  });

  it('getSessionQueue exposes generationStatus + statusMessageSafe for the player', () => {
    expect(
      getSessionQueueResponseSchema.safeParse({
        ok: true,
        data: {
          ...queueData,
          generationStatus: 'provider_rate_limited',
          generationStatusScope: null,
          statusMessageSafe: 'Waiting on the provider…',
        },
      }).success,
    ).toBe(true);
    // generationStatus is required (the player must know why generation is degraded).
    expect(getSessionQueueResponseSchema.safeParse({ ok: true, data: queueData }).success).toBe(
      false,
    );
    // …and validated against the shared literals.
    expect(
      getSessionQueueResponseSchema.safeParse({
        ok: true,
        data: {
          ...queueData,
          generationStatus: 'bogus',
          generationStatusScope: null,
          statusMessageSafe: null,
        },
      }).success,
    ).toBe(false);
  });

  it('getSessionQueue exposes the current vibe facets and the switch-pending flag', () => {
    const withStatus = {
      ...queueData,
      generationStatus: 'ok',
      generationStatusScope: null,
      statusMessageSafe: null,
    };
    expect(
      getSessionQueueResponseSchema.safeParse({
        ok: true,
        data: {
          ...withStatus,
          vibe: {
            genreTags: ['techno', 'deep house'],
            energy: 'high',
            vocalMode: 'vocal',
            voiceGender: 'female',
            ownVoice: false,
            language: 'German',
            styleStrength: 0.9,
            novelty: 0.05,
            avoid: 'saxophone',
            userPrompt: 'dark warehouse techno',
            controls: null,
          },
          switchPending: true,
        },
      }).success,
    ).toBe(true);
    // Both fields are required; a snapshot-less session sends a null vibe.
    const { vibe: _vibe, switchPending: _pending, ...withoutVibe } = withStatus;
    expect(getSessionQueueResponseSchema.safeParse({ ok: true, data: withoutVibe }).success).toBe(
      false,
    );
    // Only the projected facets — the snapshot's internals must never ride
    // along. Every projected field is present, so `stylePrompt` is the sole
    // reason this parse fails. Null guardrails stand in for a vibe created
    // before they existed.
    expect(
      getSessionQueueResponseSchema.safeParse({
        ok: true,
        data: {
          ...withStatus,
          vibe: {
            genreTags: [],
            energy: null,
            vocalMode: 'instrumental',
            voiceGender: null,
            ownVoice: false,
            language: '',
            styleStrength: null,
            novelty: null,
            avoid: '',
            userPrompt: null,
            controls: null,
            stylePrompt: 'leaked',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('getSessionQueue requires the session-level styleRevision (the loop pin watches it)', () => {
    const { styleRevision: _dropped, ...withoutRevision } = queueData;
    expect(
      getSessionQueueResponseSchema.safeParse({
        ok: true,
        data: {
          ...withoutRevision,
          generationStatus: 'ok',
          generationStatusScope: null,
          statusMessageSafe: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe('audio is app-routed only', () => {
  const base = {
    id: UUID,
    title: 'Track',
    generatedArtistName: null,
    status: 'ready',
    durationSeconds: 120,
    coverImageId: null,
    savedAt: null,
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: ['lofi'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
  };

  it('requires the downloadable gate the "Download Track" rows render from', () => {
    const { downloadable: _dropped, ...withoutDownloadable } = base;
    expect(trackSummarySchema.safeParse({ ...withoutDownloadable, audioUrl: null }).success).toBe(
      false,
    );
    expect(
      trackSummarySchema.safeParse({ ...base, audioUrl: null, downloadable: false }).success,
    ).toBe(true);
  });

  it('requires the track genre tags the player status line renders', () => {
    const { genreTags: _dropped, ...withoutTags } = base;
    expect(trackSummarySchema.safeParse({ ...withoutTags, audioUrl: null }).success).toBe(false);
    expect(trackSummarySchema.safeParse({ ...base, audioUrl: null, genreTags: [] }).success).toBe(
      true,
    );
  });

  it('accepts a relative app-route audio path', () => {
    expect(trackSummarySchema.safeParse({ ...base, audioUrl: '/api/audio/' + UUID }).success).toBe(
      true,
    );
  });

  it('rejects absolute, protocol-relative, and backslash URLs', () => {
    for (const audioUrl of [
      'https://cdn.provider.example/x.mp3',
      '//cdn.provider.example/x.mp3',
      '/\\cdn.provider.example/x.mp3',
    ]) {
      expect(trackSummarySchema.safeParse({ ...base, audioUrl }).success).toBe(false);
    }
  });
});

describe('consistent error envelope across all endpoints', () => {
  const canonicalError = makeApiError('validation_error', 'Something was wrong', true, {
    field: 'x',
  });

  it('every endpoint response accepts the one shared error shape', () => {
    for (const name of API_ENDPOINT_NAMES) {
      expect(API_CONTRACTS[name].response.safeParse(canonicalError).success).toBe(true);
    }
  });

  it('rejects a malformed error (unknown code / missing fields)', () => {
    expect(errorResponseSchema.safeParse({ ok: false, error: { code: 'boom' } }).success).toBe(
      false,
    );
    expect(
      errorResponseSchema.safeParse({
        ok: false,
        error: { code: 'not_found', message: 'x', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('a success payload parses and a mistyped success payload fails', () => {
    expect(
      startSessionResponseSchema.safeParse({
        ok: true,
        data: { session: VALID_SESSION_SUMMARY, supersededSessionId: null },
      }).success,
    ).toBe(true);
    // `status` outside the two-value lifecycle enum is rejected.
    expect(
      startSessionResponseSchema.safeParse({
        ok: true,
        data: {
          session: { ...VALID_SESSION_SUMMARY, status: 'running' },
          supersededSessionId: null,
        },
      }).success,
    ).toBe(false);
  });
});

describe('setSessionMode contract', () => {
  it('is registered as an idempotent POST /api/sessions/mode', () => {
    const contract = API_CONTRACTS.setSessionMode;
    expect(contract.method).toBe('POST');
    expect(contract.path).toBe('/api/sessions/mode');
    expect(contract.auth).toBe('admin');
    // A single-column policy write: re-sending the same mode changes nothing.
    expect(contract.retry.retryable).toBe(true);
    expect(contract.retry.idempotent).toBe(true);
  });

  it('accepts only the shared session modes', () => {
    for (const mode of SESSION_MODES) {
      expect(setSessionModeRequestSchema.safeParse({ sessionId: UUID, mode }).success).toBe(true);
    }
    expect(setSessionModeRequestSchema.safeParse({ sessionId: UUID, mode: 'bogus' }).success).toBe(
      false,
    );
    expect(setSessionModeRequestSchema.safeParse({ sessionId: UUID }).success).toBe(false);
  });

  it('answers with the updated session summary', () => {
    expect(
      setSessionModeResponseSchema.safeParse({
        ok: true,
        data: { session: { ...VALID_SESSION_SUMMARY, sessionMode: 'repeat' } },
      }).success,
    ).toBe(true);
  });
});

describe('resumeSession contract', () => {
  it('is registered as a non-retryable POST /api/sessions/resume', () => {
    const contract = API_CONTRACTS.resumeSession;
    expect(contract.method).toBe('POST');
    expect(contract.path).toBe('/api/sessions/resume');
    expect(contract.auth).toBe('admin');
    // Resume re-activates a Stopped session in place; not safe to blind-retry.
    expect(contract.retry.retryable).toBe(false);
    expect(contract.retry.idempotent).toBe(false);
    // Resume is NEVER gated by cost limits — documented in the note.
    expect(contract.retry.note.toLowerCase()).toContain('never gated');
  });

  it('request requires both sessionId and clientId', () => {
    expect(
      resumeSessionRequestSchema.safeParse({ sessionId: UUID, clientId: 'phone-1' }).success,
    ).toBe(true);
    expect(resumeSessionRequestSchema.safeParse({ sessionId: UUID }).success).toBe(false);
    expect(resumeSessionRequestSchema.safeParse({ clientId: 'phone-1' }).success).toBe(false);
  });

  it('response carries the re-activated session and the superseded session id', () => {
    expect(
      resumeSessionResponseSchema.safeParse({
        ok: true,
        data: {
          session: { ...VALID_SESSION_SUMMARY, status: 'active' },
          supersededSessionId: UUID,
        },
      }).success,
    ).toBe(true);
    // supersededSessionId is nullable (nothing was active when resumed).
    expect(
      resumeSessionResponseSchema.safeParse({
        ok: true,
        data: { session: VALID_SESSION_SUMMARY, supersededSessionId: null },
      }).success,
    ).toBe(true);
  });
});

describe('listSessions contract — My Sessions', () => {
  const validItem = {
    id: UUID,
    title: 'Late-night focus',
    coverImageId: null,
    lastActiveAt: ISO,
    status: 'stopped',
    trackCount: 3,
    totalDurationSeconds: 540,
    genreTags: ['lofi', 'ambient'],
    pinned: false,
  };
  const activeSession = {
    ...VALID_SESSION_SUMMARY,
    trackCount: 2,
    totalDurationSeconds: 360,
    genreTags: ['lofi'],
  };

  it('is registered as a read-only, retryable GET /api/sessions', () => {
    const contract = API_CONTRACTS.listSessions;
    expect(contract.method).toBe('GET');
    expect(contract.path).toBe('/api/sessions');
    expect(contract.auth).toBe('admin');
    expect(contract.retry.retryable).toBe(true);
    expect(contract.retry.idempotent).toBe(true);
  });

  it('paging mirrors getLibrary: cursor optional, limit coerced + defaulted', () => {
    expect(listSessionsRequestSchema.safeParse({ cursor: null, limit: 20 }).success).toBe(true);
    const defaulted = listSessionsRequestSchema.parse({});
    expect(defaulted.limit).toBe(50);
    // Query-string limit arrives as a string and is coerced.
    expect(listSessionsRequestSchema.parse({ limit: '10' }).limit).toBe(10);
    expect(listSessionsRequestSchema.parse({ includeActive: 'true' }).includeActive).toBe(true);
  });

  it('is DISTINCT from the track-centric getLibrary (no `view`, no track fields)', () => {
    // listSessions has no library `view` facet.
    expect(listSessionsRequestSchema.safeParse({ view: 'saved', limit: 20 }).success).toBe(false);
    // A session item is NOT a track summary — it carries no `audioUrl`/track flags.
    expect(
      sessionListItemSchema.safeParse({ ...validItem, audioUrl: '/api/audio/x' }).success,
    ).toBe(false);
  });

  it('carries bounded Track-derived activity without becoming a Track summary', () => {
    expect(sessionListItemSchema.safeParse(validItem).success).toBe(true);
    expect(sessionListItemSchema.safeParse({ ...validItem, coverImageId: UUID }).success).toBe(
      true,
    );
    expect(sessionListItemSchema.safeParse({ ...validItem, trackCount: -1 }).success).toBe(false);
    expect(
      sessionListItemSchema.safeParse({ ...validItem, totalDurationSeconds: -1 }).success,
    ).toBe(false);
    expect(
      sessionListItemSchema.safeParse({
        ...validItem,
        genreTags: ['one', 'two', 'three', 'four'],
      }).success,
    ).toBe(false);
    // Resumable sessions are Stopped; the field is the two-value lifecycle enum.
    expect(sessionListItemSchema.safeParse({ ...validItem, status: 'paused' }).success).toBe(false);
  });

  it('response is a page of session items plus a nullable nextCursor', () => {
    expect(
      listSessionsResponseSchema.safeParse({
        ok: true,
        data: { items: [validItem], nextCursor: 'opaque-cursor', activeSession, pinned: [] },
      }).success,
    ).toBe(true);
    expect(
      listSessionsResponseSchema.safeParse({
        ok: true,
        data: { items: [], nextCursor: null, activeSession: null, pinned: [validItem] },
      }).success,
    ).toBe(true);
  });
});

describe('getLibrary contract — smart-list Track activity', () => {
  const item = {
    id: UUID,
    title: 'Night Drive',
    generatedArtistName: 'Liedmotif',
    status: 'ready',
    durationSeconds: 180,
    coverImageId: null,
    audioUrl: `/api/audio/${UUID}`,
    savedAt: ISO,
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: ['lofi', 'ambient'],
    vocalMode: 'instrumental',
    hasLyrics: false,
    downloadable: true,
    createdAt: ISO,
    hasPlayed: false,
    originSessionId: UUID,
    originSessionTitle: 'Night Shift',
  };

  it('distinguishes never-played History rows without weakening app-routed audio', () => {
    expect(libraryTrackItemSchema.safeParse(item).success).toBe(true);
    expect(libraryTrackItemSchema.safeParse({ ...item, hasPlayed: true }).success).toBe(true);
    expect(
      libraryTrackItemSchema.safeParse({ ...item, audioUrl: 'https://provider.example/a.mp3' })
        .success,
    ).toBe(false);
  });
});

describe('sessionSummarySchema carries controller state', () => {
  it('accepts a summary with generationStatus, sessionMode, coverImageId, statusMessageSafe', () => {
    expect(sessionSummarySchema.safeParse(VALID_SESSION_SUMMARY).success).toBe(true);
  });

  it('keeps `status` the two-value lifecycle enum (no paused/completed)', () => {
    expect(
      sessionSummarySchema.safeParse({ ...VALID_SESSION_SUMMARY, status: 'stopped' }).success,
    ).toBe(true);
    expect(
      sessionSummarySchema.safeParse({ ...VALID_SESSION_SUMMARY, status: 'paused' }).success,
    ).toBe(false);
  });

  it('requires the generation-controller fields (strict, not optional)', () => {
    const { generationStatus: _omitted, ...withoutGenerationStatus } = VALID_SESSION_SUMMARY;
    expect(sessionSummarySchema.safeParse(withoutGenerationStatus).success).toBe(false);
  });

  it('validates generationStatus and sessionMode against the shared literals', () => {
    // `repeat_cost_limit` is a generation-controller status, never a lifecycle state.
    expect(
      sessionSummarySchema.safeParse({
        ...VALID_SESSION_SUMMARY,
        generationStatus: 'repeat_cost_limit',
      }).success,
    ).toBe(true);
    expect(
      sessionSummarySchema.safeParse({ ...VALID_SESSION_SUMMARY, generationStatus: 'bogus' })
        .success,
    ).toBe(false);
    expect(
      sessionSummarySchema.safeParse({ ...VALID_SESSION_SUMMARY, sessionMode: 'repeat' }).success,
    ).toBe(true);
    expect(
      sessionSummarySchema.safeParse({ ...VALID_SESSION_SUMMARY, sessionMode: 'bogus' }).success,
    ).toBe(false);
  });
});

describe('headroom-blocked refusal', () => {
  it('exposes a `session_headroom_blocked` error code', () => {
    expect(API_ERROR_CODES).toContain('session_headroom_blocked');
  });

  it('startSession and moreLikeThis can return the headroom-blocked refusal', () => {
    // Creation-time gate: below the minimum headroom, NO session is created and the
    // client is prompted to Resume (My Sessions) or browse the Library.
    const blocked = makeApiError(
      'session_headroom_blocked',
      'Not enough generation headroom to start a session. Resume a session or play your library.',
      false,
    );
    expect(startSessionResponseSchema.safeParse(blocked).success).toBe(true);
    expect(moreLikeThisResponseSchema.safeParse(blocked).success).toBe(true);
  });
});

describe('apiResponse helper', () => {
  it('wraps a data schema into an ok/error discriminated union', () => {
    const schema = apiResponse(z.strictObject({ value: z.number() }));
    expect(schema.safeParse({ ok: true, data: { value: 1 } }).success).toBe(true);
    expect(schema.safeParse(makeApiError('internal_error', 'x')).success).toBe(true);
    // wrong data shape is rejected.
    expect(schema.safeParse({ ok: true, data: { value: 'no' } }).success).toBe(false);
  });
});

describe('getTrack response (standalone, not in the endpoint registry)', () => {
  const validTrack = {
    id: UUID,
    title: 'Quiet rain',
    generatedArtistName: 'Liedmotif',
    status: 'ready',
    durationSeconds: 180,
    coverImageId: null,
    audioUrl: '/api/audio/' + UUID,
    savedAt: ISO,
    favoritedAt: null,
    inCuratedPlaylist: false,
    dislikedAt: null,
    genreTags: [],
    vocalMode: 'vocal',
    hasLyrics: true,
    downloadable: true,
  };

  it('does not widen the endpoint registry', () => {
    expect(API_ENDPOINT_NAMES).toHaveLength(43);
    expect(API_ENDPOINT_NAMES).not.toContain('getTrack');
  });

  it('wraps a trackSummary and shares the one error shape', () => {
    expect(getTrackResponseSchema.safeParse({ ok: true, data: validTrack }).success).toBe(true);
    expect(
      getTrackResponseSchema.safeParse(makeApiError('not_found', 'Track not found.')).success,
    ).toBe(true);
  });

  it('still enforces the app-routed audioUrl guard', () => {
    expect(
      getTrackResponseSchema.safeParse({
        ok: true,
        data: { ...validTrack, audioUrl: 'https://cdn.example/leak.mp3' },
      }).success,
    ).toBe(false);
  });
});
