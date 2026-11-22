// Thin, typed browser client for the session/player API contracts.
//
// Every Liedmotif endpoint answers with the shared discriminated envelope
// (`{ ok: true, data } | { ok: false, error }`), so a single `callApi` decodes them
// all and the player/My-Sessions UIs branch on `result.ok`. Provider keys and signed
// URLs never travel here — `audioUrl` is always a same-origin `/api/audio/...` path
// minted server-side.

import {
  type ApiErrorCode,
  type RegenerateSessionCoverRequest,
  type ChangeVibeResponse,
  changeVibeResponseSchema,
  type DeleteSessionResponse,
  deleteSessionResponseSchema,
  type DeleteTrackResponse,
  deleteTrackResponseSchema,
  type DislikeTrackResponse,
  dislikeTrackResponseSchema,
  type FavoriteTrackResponse,
  favoriteTrackResponseSchema,
  type FeedbackType,
  type GetChromeResponse,
  getChromeResponseSchema,
  type GetDiagnosticsResponse,
  getDiagnosticsResponseSchema,
  type GetLibraryResponse,
  getLibraryResponseSchema,
  type GetSessionQueueResponse,
  getSessionQueueResponseSchema,
  type GetTrackResponse,
  getTrackResponseSchema,
  getTrackLyricsResponseSchema,
  type TrackLyrics,
  getTrackDetailsResponseSchema,
  type TrackDetails,
  type LibraryView,
  type ListSessionsResponse,
  listSessionsResponseSchema,
  listSessionTracksResponseSchema,
  type SessionTracksData,
  playSessionTrackResponseSchema,
  type SearchResponseData,
  type SearchScope,
  type SearchSort,
  searchResponseSchema,
  type LoopLeaseRequest,
  type LoopLeaseResponse,
  loopLeaseResponseSchema,
  type MoreLikeThisResponse,
  moreLikeThisResponseSchema,
  type RenameSessionResponse,
  renameSessionResponseSchema,
  type SetSessionPinnedResponse,
  setSessionPinnedResponseSchema,
  type ConvertSessionToPlaylistResponse,
  convertSessionToPlaylistResponseSchema,
  type RenameTrackResponse,
  renameTrackResponseSchema,
  type ResumeSessionResponse,
  resumeSessionResponseSchema,
  type TryAgainSessionResponse,
  tryAgainSessionResponseSchema,
  type SaveTrackResponse,
  saveTrackResponseSchema,
  type AddPlaylistTracksResponse,
  addPlaylistTracksResponseSchema,
  type ApplyTrackMembershipsResponse,
  applyTrackMembershipsResponseSchema,
  type CreatePlaylistResponse,
  createPlaylistResponseSchema,
  type DeletePlaylistResponse,
  deletePlaylistResponseSchema,
  type GetLoungePlaylistResponse,
  getLoungePlaylistResponseSchema,
  type GetPlaylistResponse,
  getPlaylistResponseSchema,
  type ListLoungeResponse,
  listLoungeResponseSchema,
  type ListPlaylistsResponse,
  listPlaylistsResponseSchema,
  type MarkPlaylistPlayedResponse,
  markPlaylistPlayedResponseSchema,
  type RemovePlaylistTrackResponse,
  removePlaylistTrackResponseSchema,
  type SharePlaylistResponse,
  sharePlaylistResponseSchema,
  type GetPlaylistShareResponse,
  getPlaylistShareResponseSchema,
  type ShareAudience,
  type PinPlaylistResponse,
  pinPlaylistResponseSchema,
  type ModerateLoungePlaylistResponse,
  moderateLoungePlaylistResponseSchema,
  type DeletePlaylistCoverResponse,
  deletePlaylistCoverResponseSchema,
  type PlaylistCoverStatusResponse,
  playlistCoverStatusResponseSchema,
  type RegeneratePlaylistCoverRequest,
  type RegeneratePlaylistCoverResponse,
  regeneratePlaylistCoverResponseSchema,
  type SelectPlaylistCoverResponse,
  selectPlaylistCoverResponseSchema,
  type UploadPlaylistCoverResponse,
  uploadPlaylistCoverResponseSchema,
  type RenamePlaylistResponse,
  renamePlaylistResponseSchema,
  type SetPlaylistOrderResponse,
  setPlaylistOrderResponseSchema,
  type SendFeedbackResponse,
  sendFeedbackResponseSchema,
  type SessionMode,
  type SetSessionModeResponse,
  setSessionModeResponseSchema,
  type SetSessionDurationResponse,
  setSessionDurationResponseSchema,
  type AssistantTone,
  assistantToneResponseSchema,
  type GenerationSettings,
  type UpdateGenerationSettingsRequest,
  generationSettingsResponseSchema,
  type PlaybackReportType,
  type PlaybackSettings,
  type UpdatePlaybackSettingsRequest,
  playbackSettingsResponseSchema,
  type StartSessionRequest,
  type StartSessionResponse,
  startSessionResponseSchema,
  type StopSessionResponse,
  stopSessionResponseSchema,
  reportPlaybackStateResponseSchema,
  type DeleteSessionCoverResponse,
  deleteSessionCoverResponseSchema,
  type RegenerateSessionCoverResponse,
  regenerateSessionCoverResponseSchema,
  type SelectSessionCoverResponse,
  selectSessionCoverResponseSchema,
  type SessionCoverStatusResponse,
  sessionCoverStatusResponseSchema,
  type UploadSessionCoverResponse,
  uploadSessionCoverResponseSchema,
  type ChangeVibeIntentInput,
  type VoiceProfileResponse,
  voiceProfileResponseSchema,
  MAX_PLAYLIST_PAGE_LIMIT,
  MAX_PLAYLISTS_LIST_PAGE_LIMIT,
  type ListeningRange,
  type ListeningStatsData,
  type CostComparisonData,
  costComparisonResponseSchema,
  listeningStatsResponseSchema,
  type ReportListeningRequest,
  reportListeningResponseSchema,
  clearListeningHistoryResponseSchema,
  resetLearnedTasteResponseSchema,
  dismissSurpriseResponseSchema,
  pendingSurpriseResponseSchema,
  proposeSurpriseResponseSchema,
  type ProposeSurpriseRequest,
  type StartSurpriseRequest,
  type SurpriseProposal,
  setPersonalizationResponseSchema,
} from '@liedmotif/shared';
import { announceLibraryWrite } from '@/lib/offline/library-writes';
import { OFFLINE_MESSAGE } from '@/lib/http/api-fetch';
import { isOnline, reportServerAnswered, reportServerUnreachable } from '@/lib/online-state';

/** The decoded result of an API call: the success `data`, or the safe error shape. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: ApiErrorCode; message: string; retryable: boolean; details?: unknown };
    };

/**
 * The structural slice of a contract response schema `callApi` needs: `safeParse`
 * decoding the FULL `{ ok, ... }` envelope. Typed structurally so this client need
 * not depend on `zod` directly; the real `*ResponseSchema`s from `@liedmotif/shared`
 * satisfy it. The schema validates the success `data` too — so the `trackSummary`
 * audioUrl guard is enforced here and a malformed body is rejected, never
 * passed through to the UI.
 */
interface ResponseContract<T> {
  safeParse(data: unknown): { success: true; data: ApiResult<T> } | { success: false };
}

const UNEXPECTED_RESPONSE = {
  ok: false as const,
  error: {
    code: 'internal_error' as const,
    message: 'Unexpected response from the server.',
    retryable: true,
  },
};

const OFFLINE_RESULT = {
  ok: false as const,
  error: {
    code: 'internal_error' as const,
    message: OFFLINE_MESSAGE,
    retryable: true,
  },
};

async function callApi<T>(
  path: string,
  schema: ResponseContract<T>,
  init?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    /** Multipart body (uploads) — mutually exclusive with `body`. */
    form?: FormData;
    signal?: AbortSignal;
    /** Let the request outlive the page (a last report sent while it closes). */
    keepalive?: boolean;
  },
): Promise<ApiResult<T>> {
  const method = init?.method ?? 'GET';
  // Listen-only while offline: an action is refused here, never queued.
  if (method !== 'GET' && !isOnline()) return OFFLINE_RESULT;
  try {
    const res = await fetch(path, {
      method,
      // A FormData body must carry no explicit content-type: fetch writes the
      // multipart boundary itself.
      headers:
        init?.body !== undefined && !init.form ? { 'content-type': 'application/json' } : undefined,
      body: init?.form ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal: init?.signal,
      keepalive: init?.keepalive,
    });
    reportServerAnswered();
    const json = await res.json().catch(() => null);
    // Validate against the endpoint's contract before returning. A response that
    // doesn't match (e.g. a provider/stream URL smuggled into `audioUrl`) is surfaced
    // as a typed error — the raw body is never handed back.
    const parsed = schema.safeParse(json);
    if (!parsed.success) return UNEXPECTED_RESPONSE;
    if (parsed.data.ok && method !== 'GET') announceLibraryWrite(path);
    return parsed.data;
  } catch {
    if (!init?.signal?.aborted) reportServerUnreachable();
    return {
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Network error. Check your connection.',
        retryable: true,
      },
    };
  }
}

// Success-payload helpers (the `data` half of each contract envelope).
type SuccessData<R> = R extends { ok: true; data: infer D } ? D : never;
type StartSessionData = SuccessData<StartSessionResponse>;
type ChangeVibeData = SuccessData<ChangeVibeResponse>;
type StopSessionData = SuccessData<StopSessionResponse>;
type DeleteSessionData = SuccessData<DeleteSessionResponse>;
type ResumeSessionData = SuccessData<ResumeSessionResponse>;
type TryAgainSessionData = SuccessData<TryAgainSessionResponse>;
type ListSessionsData = SuccessData<ListSessionsResponse>;
type SessionQueueData = SuccessData<GetSessionQueueResponse>;
export type DiagnosticsData = SuccessData<GetDiagnosticsResponse>;
export type ChromeData = SuccessData<GetChromeResponse>;
type MoreLikeThisData = SuccessData<MoreLikeThisResponse>;
type RenameSessionData = SuccessData<RenameSessionResponse>;
type SetSessionPinnedData = SuccessData<SetSessionPinnedResponse>;
type ConvertSessionToPlaylistData = SuccessData<ConvertSessionToPlaylistResponse>;
type SetSessionModeData = SuccessData<SetSessionModeResponse>;
type SetSessionDurationData = SuccessData<SetSessionDurationResponse>;
type RenameTrackData = SuccessData<RenameTrackResponse>;
type SaveTrackData = SuccessData<SaveTrackResponse>;
type FavoriteTrackData = SuccessData<FavoriteTrackResponse>;
type DislikeTrackData = SuccessData<DislikeTrackResponse>;
type DeleteTrackData = SuccessData<DeleteTrackResponse>;
type SendFeedbackData = SuccessData<SendFeedbackResponse>;
type LibraryData = SuccessData<GetLibraryResponse>;
export type ListPlaylistsData = SuccessData<ListPlaylistsResponse>;
export type ListLoungeData = SuccessData<ListLoungeResponse>;
export type CreatePlaylistData = SuccessData<CreatePlaylistResponse>;
type RenamePlaylistData = SuccessData<RenamePlaylistResponse>;
type DeletePlaylistData = SuccessData<DeletePlaylistResponse>;
type SharePlaylistData = SuccessData<SharePlaylistResponse>;
export type PlaylistShareData = SuccessData<GetPlaylistShareResponse>;
type PinPlaylistData = SuccessData<PinPlaylistResponse>;
type ModerateLoungePlaylistData = SuccessData<ModerateLoungePlaylistResponse>;
type MarkPlaylistPlayedData = SuccessData<MarkPlaylistPlayedResponse>;
export type GetPlaylistData = SuccessData<GetPlaylistResponse>;
export type GetLoungePlaylistData = SuccessData<GetLoungePlaylistResponse>;
export type AddPlaylistTracksData = SuccessData<AddPlaylistTracksResponse>;
type RemovePlaylistTrackData = SuccessData<RemovePlaylistTrackResponse>;
type SetPlaylistOrderData = SuccessData<SetPlaylistOrderResponse>;
export type ApplyTrackMembershipsData = SuccessData<ApplyTrackMembershipsResponse>;
export type RegeneratePlaylistCoverData = SuccessData<RegeneratePlaylistCoverResponse>;
export type PlaylistCoverStatusData = SuccessData<PlaylistCoverStatusResponse>;
type SelectPlaylistCoverData = SuccessData<SelectPlaylistCoverResponse>;
type DeletePlaylistCoverData = SuccessData<DeletePlaylistCoverResponse>;
type UploadPlaylistCoverData = SuccessData<UploadPlaylistCoverResponse>;
type TrackData = SuccessData<GetTrackResponse>;
type LoopLeaseData = SuccessData<LoopLeaseResponse>;
export type RegenerateSessionCoverData = SuccessData<RegenerateSessionCoverResponse>;
export type SessionCoverStatusData = SuccessData<SessionCoverStatusResponse>;
export type SelectSessionCoverData = SuccessData<SelectSessionCoverResponse>;
type UploadSessionCoverData = SuccessData<UploadSessionCoverResponse>;
export type DeleteSessionCoverData = SuccessData<DeleteSessionCoverResponse>;
export type VoiceProfileData = SuccessData<VoiceProfileResponse>;

export function startSession(
  input: StartSessionRequest,
  signal?: AbortSignal,
): Promise<ApiResult<StartSessionData>> {
  return callApi<StartSessionData>('/api/sessions', startSessionResponseSchema, {
    method: 'POST',
    body: input,
    signal,
  });
}

export function stopSession(sessionId: string): Promise<ApiResult<StopSessionData>> {
  return callApi<StopSessionData>('/api/sessions/stop', stopSessionResponseSchema, {
    method: 'POST',
    body: { sessionId },
  });
}

/** The per-change Change Vibe options: the switch-now toggle. One shape for
 * every layer of the submit path (sheet → provider request → this call). */
export interface ChangeVibeOptions {
  switchImmediately?: boolean;
  targetDurationMinutes?: number | null;
}

export function changeVibe(
  sessionId: string,
  input: ChangeVibeIntentInput,
  options: ChangeVibeOptions = {},
): Promise<ApiResult<ChangeVibeData>> {
  return callApi<ChangeVibeData>('/api/sessions/change-vibe', changeVibeResponseSchema, {
    method: 'POST',
    body: {
      sessionId,
      input,
      ...(options.targetDurationMinutes !== undefined
        ? { targetDurationMinutes: options.targetDurationMinutes }
        : {}),
      ...(options.switchImmediately ? { switchImmediately: true } : {}),
    },
  });
}

export function setSessionDuration(
  sessionId: string,
  targetDurationMinutes: number | null,
  sessionMode?: SessionMode,
): Promise<ApiResult<SetSessionDurationData>> {
  return callApi<SetSessionDurationData>(
    '/api/sessions/duration',
    setSessionDurationResponseSchema,
    { method: 'POST', body: { sessionId, targetDurationMinutes, sessionMode } },
  );
}

export function deleteSession(sessionId: string): Promise<ApiResult<DeleteSessionData>> {
  return callApi<DeleteSessionData>('/api/sessions/delete', deleteSessionResponseSchema, {
    method: 'POST',
    body: { sessionId },
  });
}

/** Replace the Session Name with a Given Name (one-way, cosmetic). */
export function renameSession(
  sessionId: string,
  title: string,
): Promise<ApiResult<RenameSessionData>> {
  return callApi<RenameSessionData>('/api/sessions/rename', renameSessionResponseSchema, {
    method: 'POST',
    body: { sessionId, title },
  });
}

/** A new Playlist of the Session's listed Tracks; each call mints another. */
export function convertSessionToPlaylist(
  sessionId: string,
): Promise<ApiResult<ConvertSessionToPlaylistData>> {
  return callApi<ConvertSessionToPlaylistData>(
    '/api/sessions/convert-to-playlist',
    convertSessionToPlaylistResponseSchema,
    { method: 'POST', body: { sessionId } },
  );
}

/** Pin or unpin a Session for the My Sessions Pinned section (capped per owner). */
export function setSessionPinned(
  sessionId: string,
  pinned: boolean,
): Promise<ApiResult<SetSessionPinnedData>> {
  return callApi<SetSessionPinnedData>('/api/sessions/pin', setSessionPinnedResponseSchema, {
    method: 'POST',
    body: { sessionId, pinned },
  });
}

/** Set the Session's generation policy: keep generating
 *  new Tracks, or loop the ones the Session already has. */
export function setSessionMode(
  sessionId: string,
  mode: SessionMode,
): Promise<ApiResult<SetSessionModeData>> {
  return callApi<SetSessionModeData>('/api/sessions/mode', setSessionModeResponseSchema, {
    method: 'POST',
    body: { sessionId, mode },
  });
}

export function resumeSession(
  sessionId: string,
  clientId: string,
): Promise<ApiResult<ResumeSessionData>> {
  return callApi<ResumeSessionData>('/api/sessions/resume', resumeSessionResponseSchema, {
    method: 'POST',
    body: { sessionId, clientId },
  });
}

/** Try again on an Active Session with nothing to play: one more paid batch,
 *  which the worker decides and spends under the usual limits. */
export function tryAgainSession(sessionId: string): Promise<ApiResult<TryAgainSessionData>> {
  return callApi<TryAgainSessionData>('/api/sessions/try-again', tryAgainSessionResponseSchema, {
    method: 'POST',
    body: { sessionId },
  });
}

export function playSessionTrack(
  sessionId: string,
  trackId: string,
  clientId: string,
): Promise<ApiResult<ResumeSessionData>> {
  return callApi<ResumeSessionData>('/api/sessions/play-track', playSessionTrackResponseSchema, {
    method: 'POST',
    body: { sessionId, trackId, clientId },
  });
}

export function listSessions(
  options: {
    cursor?: string | null;
    limit?: number;
    includeActive?: boolean;
    includePinned?: boolean;
  } = {},
): Promise<ApiResult<ListSessionsData>> {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.includeActive) params.set('includeActive', 'true');
  if (options.includePinned) params.set('includePinned', 'true');
  const query = params.toString();
  return callApi<ListSessionsData>(
    `/api/sessions${query ? `?${query}` : ''}`,
    listSessionsResponseSchema,
  );
}

export function listSessionTracks(
  sessionId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<ApiResult<SessionTracksData>> {
  const params = new URLSearchParams({ sessionId });
  if (cursor !== null) params.set('cursor', cursor);
  return callApi(`/api/sessions/tracks?${params}`, listSessionTracksResponseSchema, { signal });
}

// Every parameter travels explicitly — omit-defaults prettiness belongs to the
// address bar (`searchQueryString`), not the wire, so the two cannot drift.
export function search(
  params: { q: string; scope: SearchScope; sort: SearchSort; lyrics: boolean },
  signal?: AbortSignal,
): Promise<ApiResult<SearchResponseData>> {
  const query = new URLSearchParams({
    q: params.q,
    scope: params.scope,
    sort: params.sort,
    lyrics: params.lyrics ? '1' : '0',
  });
  return callApi<SearchResponseData>(`/api/search?${query}`, searchResponseSchema, { signal });
}

/** `full` asks for every slot of the Session instead of the windowed read. */
export function getSessionQueue(
  sessionId: string,
  signal?: AbortSignal,
  options: { full?: boolean } = {},
): Promise<ApiResult<SessionQueueData>> {
  const query = new URLSearchParams({ sessionId });
  if (options.full) query.set('full', '1');
  return callApi<SessionQueueData>(`/api/sessions/queue?${query}`, getSessionQueueResponseSchema, {
    signal,
  });
}

export function regenerateSessionCover(
  activitySessionId: string,
  options: Omit<RegenerateSessionCoverRequest, 'activitySessionId'> = {},
): Promise<ApiResult<RegenerateSessionCoverData>> {
  return callApi<RegenerateSessionCoverData>(
    '/api/sessions/cover/regenerate',
    regenerateSessionCoverResponseSchema,
    { method: 'POST', body: { activitySessionId, ...options } },
  );
}

export function getSessionCoverStatus(
  activitySessionId: string,
  signal?: AbortSignal,
): Promise<ApiResult<SessionCoverStatusData>> {
  return callApi<SessionCoverStatusData>(
    '/api/sessions/cover/status',
    sessionCoverStatusResponseSchema,
    { method: 'POST', body: { activitySessionId }, signal },
  );
}

/**
 * Upload an own image as a Session cover (multipart; cropped client-side,
 * normalized server-side). The Session keeps its cover — the upload lands in
 * the history and is applied with `selectSessionCover`.
 */
export function uploadSessionCover(
  activitySessionId: string,
  file: File,
): Promise<ApiResult<UploadSessionCoverData>> {
  const form = new FormData();
  form.set('activitySessionId', activitySessionId);
  form.set('file', file);
  return callApi<UploadSessionCoverData>(
    '/api/sessions/cover/upload',
    uploadSessionCoverResponseSchema,
    { method: 'POST', form },
  );
}

export function selectSessionCover(
  activitySessionId: string,
  coverImageId: string,
): Promise<ApiResult<SelectSessionCoverData>> {
  return callApi<SelectSessionCoverData>(
    '/api/sessions/cover/select',
    selectSessionCoverResponseSchema,
    { method: 'POST', body: { activitySessionId, coverImageId } },
  );
}

export function deleteSessionCover(
  activitySessionId: string,
  coverImageId: string,
): Promise<ApiResult<DeleteSessionCoverData>> {
  return callApi<DeleteSessionCoverData>(
    '/api/sessions/cover/delete',
    deleteSessionCoverResponseSchema,
    { method: 'POST', body: { activitySessionId, coverImageId } },
  );
}

export function getDiagnostics(signal?: AbortSignal): Promise<ApiResult<DiagnosticsData>> {
  return callApi<DiagnosticsData>('/api/diagnostics', getDiagnosticsResponseSchema, { signal });
}

/** The app-shell chrome slice (usage + active Session); Member-accessible. */
export function getChrome(signal?: AbortSignal): Promise<ApiResult<ChromeData>> {
  return callApi<ChromeData>('/api/chrome', getChromeResponseSchema, { signal });
}

/** Owner playback settings (blend on/off + crossfade length); defaults merged server-side. */
export function getPlaybackSettings(): Promise<ApiResult<PlaybackSettings>> {
  return callApi<PlaybackSettings>('/api/settings/playback', playbackSettingsResponseSchema);
}

/** Persist a playback-settings patch; answers with the full effective settings. */
export function updatePlaybackSettings(
  patch: UpdatePlaybackSettingsRequest,
): Promise<ApiResult<PlaybackSettings>> {
  return callApi<PlaybackSettings>('/api/settings/playback', playbackSettingsResponseSchema, {
    method: 'POST',
    body: patch,
  });
}

/** Save the tone the user gives the Assistant; answers with it as stored. */
export function updateAssistantTone(tone: AssistantTone): Promise<ApiResult<AssistantTone>> {
  return callApi<AssistantTone>('/api/settings/assistant-tone', assistantToneResponseSchema, {
    method: 'POST',
    body: tone,
  });
}

/** Owner Buffer enablement and ready-ahead target; defaults merged server-side. */
export function getGenerationSettings(): Promise<ApiResult<GenerationSettings>> {
  return callApi<GenerationSettings>('/api/settings/generation', generationSettingsResponseSchema);
}

/** Persist a generation-settings patch; answers with the full effective settings. */
export function updateGenerationSettings(
  patch: UpdateGenerationSettingsRequest,
): Promise<ApiResult<GenerationSettings>> {
  return callApi<GenerationSettings>('/api/settings/generation', generationSettingsResponseSchema, {
    method: 'POST',
    body: patch,
  });
}

/** The ACKNOWLEDGED repeat-one loop-lease operation: unlike playback reports
 * this is never fire-and-forget — the response carries the applied hold state
 * the UI must reflect. The signal lets the lease protocol abort a request hung
 * past its stale deadline. */
export function applyLoopLease(
  body: LoopLeaseRequest,
  signal?: AbortSignal,
): Promise<ApiResult<LoopLeaseData>> {
  return callApi<LoopLeaseData>('/api/sessions/loop-lease', loopLeaseResponseSchema, {
    method: 'POST',
    body,
    signal,
  });
}

/** Fire-and-forget playback report (idempotent via `clientEventId`; failures are ignored). */
export function reportPlayback(body: {
  sessionId: string;
  clientId: string;
  clientEventId: string;
  type: PlaybackReportType;
  queueItemId: string | null;
  trackId: string | null;
  positionSeconds: number | null;
  clientTimestamp: string;
  queueWrapped?: boolean;
  shuffled?: boolean;
}): void {
  // Fire-and-forget: still validated against the contract (failures are ignored).
  void callApi<unknown>('/api/sessions/playback', reportPlaybackStateResponseSchema, {
    method: 'POST',
    body,
  });
}

/** Personal-analytics progress. Best-effort: playback never waits on it. */
export function reportListening(
  body: ReportListeningRequest,
): Promise<ApiResult<{ accepted: true }>> {
  return callApi<{ accepted: true }>('/api/listening/report', reportListeningResponseSchema, {
    method: 'POST',
    body,
    // The report flushed as the page hides must survive the page.
    keepalive: true,
  });
}

export function fetchListeningStats(range: ListeningRange): Promise<ApiResult<ListeningStatsData>> {
  return callApi<ListeningStatsData>(
    `/api/listening/stats?range=${range}`,
    listeningStatsResponseSchema,
  );
}

export function fetchCostComparison(range: ListeningRange): Promise<ApiResult<CostComparisonData>> {
  return callApi<CostComparisonData>(
    `/api/settings/cost-comparison?range=${range}`,
    costComparisonResponseSchema,
  );
}

export function clearListeningHistory(): Promise<ApiResult<{ cleared: true }>> {
  return callApi<{ cleared: true }>(
    '/api/listening/clear-history',
    clearListeningHistoryResponseSchema,
    { method: 'POST', body: {} },
  );
}

export function savePersonalization(enabled: boolean): Promise<ApiResult<{ enabled: boolean }>> {
  return callApi<{ enabled: boolean }>(
    '/api/listening/personalization',
    setPersonalizationResponseSchema,
    { method: 'POST', body: { enabled } },
  );
}

export function resetLearnedTaste(): Promise<ApiResult<{ reset: true }>> {
  return callApi<{ reset: true }>('/api/listening/reset-taste', resetLearnedTasteResponseSchema, {
    method: 'POST',
    body: {},
  });
}

/** The caller's pending Surprise Me proposal, or null. Spends nothing. */
export function getPendingSurprise(): Promise<ApiResult<{ proposal: SurpriseProposal | null }>> {
  return callApi<{ proposal: SurpriseProposal | null }>(
    '/api/surprise-me',
    pendingSurpriseResponseSchema,
  );
}

/** Surprise Me: propose a vibe, or replace the one this tab shows. Spends at
 * most one text-LLM call and never buys music. */
export function proposeSurprise(
  body: ProposeSurpriseRequest,
  signal?: AbortSignal,
): Promise<ApiResult<{ proposal: SurpriseProposal }>> {
  return callApi<{ proposal: SurpriseProposal }>(
    '/api/surprise-me',
    proposeSurpriseResponseSchema,
    { method: 'POST', body, signal },
  );
}

/** Start the previewed proposal. Buys music like Start Session; runs no text LLM. */
export function startSurprise(
  body: StartSurpriseRequest,
  signal?: AbortSignal,
): Promise<ApiResult<StartSessionData>> {
  return callApi<StartSessionData>('/api/surprise-me/start', startSessionResponseSchema, {
    method: 'POST',
    body,
    signal,
  });
}

export function dismissSurprise(proposalId: string): Promise<ApiResult<{ dismissed: true }>> {
  return callApi<{ dismissed: true }>('/api/surprise-me', dismissSurpriseResponseSchema, {
    method: 'DELETE',
    body: { proposalId },
  });
}

// --- Listener feedback loop --------------------------------------------------

/** Unsave a track everywhere (retention is membership: removes it from every
 *  playlist, back to Ephemeral). Saving goes through `applyTrackMemberships`. */
export function unsaveTrack(trackId: string): Promise<ApiResult<SaveTrackData>> {
  return callApi<SaveTrackData>('/api/tracks/save', saveTrackResponseSchema, {
    method: 'POST',
    body: { trackId, saved: false },
  });
}

/** Favorite/unfavorite a track (favorite implies save). */
export function favoriteTrack(
  trackId: string,
  favorited: boolean,
): Promise<ApiResult<FavoriteTrackData>> {
  return callApi<FavoriteTrackData>('/api/tracks/favorite', favoriteTrackResponseSchema, {
    method: 'POST',
    body: { trackId, favorited },
  });
}

/** Dislike = reroll the same prompt + reject the track (hidden now, deleted ~24h). */
export function dislikeTrack(trackId: string): Promise<ApiResult<DislikeTrackData>> {
  return callApi<DislikeTrackData>('/api/tracks/dislike', dislikeTrackResponseSchema, {
    method: 'POST',
    body: { trackId },
  });
}

/** Replace one Track title with a Given Name (siblings untouched). */
export function renameTrack(trackId: string, title: string): Promise<ApiResult<RenameTrackData>> {
  return callApi<RenameTrackData>('/api/tracks/rename', renameTrackResponseSchema, {
    method: 'POST',
    body: { trackId, title },
  });
}

/** Explicitly delete an owned Track and purge its audio; never records feedback. */
export function deleteTrack(trackId: string): Promise<ApiResult<DeleteTrackData>> {
  return callApi<DeleteTrackData>('/api/tracks/delete', deleteTrackResponseSchema, {
    method: 'POST',
    body: { trackId },
  });
}

/** General audit write (the Skip soft-negative); NEVER mutates flags or steers. */
export function sendFeedback(body: {
  trackId: string;
  sessionId: string | null;
  type: FeedbackType;
  value: string | null;
  freeformText: string | null;
}): Promise<ApiResult<SendFeedbackData>> {
  return callApi<SendFeedbackData>('/api/feedback', sendFeedbackResponseSchema, {
    method: 'POST',
    body,
  });
}

/** List the track-centric library (saved / favorites / history) with cursor paging.
 *  `search` filters by track title, origin Session title, or genre tag. */
export function getLibrary(
  view: LibraryView,
  options: { cursor?: string | null; search?: string; signal?: AbortSignal } = {},
): Promise<ApiResult<LibraryData>> {
  const params = new URLSearchParams({ view });
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.search) params.set('search', options.search);
  return callApi<LibraryData>(`/api/library?${params.toString()}`, getLibraryResponseSchema, {
    signal: options.signal,
  });
}

// --- Playlists (retention-is-membership) -------------------------------------

/** One page of the owner's playlists (Favorites and the Library pins ride the first page). With
 *  `containsTrackId`, each summary reports whether that track is a member —
 *  the picker read. `search` filters by playlist name or member track title. */
export function listPlaylists(
  options: {
    containsTrackId?: string | null;
    search?: string;
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<ApiResult<ListPlaylistsData>> {
  const params = new URLSearchParams();
  if (options.containsTrackId) params.set('trackId', options.containsTrackId);
  if (options.search) params.set('search', options.search);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit != null) params.set('limit', String(options.limit));
  const query = params.toString();
  return callApi<ListPlaylistsData>(
    `/api/playlists${query ? `?${query}` : ''}`,
    listPlaylistsResponseSchema,
  );
}

/** One page of the Lounge: every non-empty In-Lounge playlist
 *  across all owners, attributed, the viewer's Pins first, then newest-shared
 *  first. `query`/`owner` narrow the same list (filter semantics — the order
 *  never changes). */
export function listLoungePlaylists(
  options: { cursor?: string | null; query?: string; owner?: string | null } = {},
): Promise<ApiResult<ListLoungeData>> {
  const params = new URLSearchParams();
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.query) params.set('query', options.query);
  if (options.owner) params.set('owner', options.owner);
  const search = params.toString();
  return callApi<ListLoungeData>(
    `/api/lounge${search ? `?${search}` : ''}`,
    listLoungeResponseSchema,
  );
}

/** Load the owner's COMPLETE playlist list through the paginated endpoint —
 *  the membership pickers rewrite a track's whole membership, so an unseen
 *  page would read as "not a member" and silently drop it. */
export async function getAllPlaylists(
  options: { containsTrackId?: string | null } = {},
): Promise<ApiResult<ListPlaylistsData>> {
  const pageOptions = { ...options, limit: MAX_PLAYLISTS_LIST_PAGE_LIMIT };
  const first = await listPlaylists(pageOptions);
  if (!first.ok) return first;

  if (!first.data.nextCursor) return first;

  const byId = new Map(first.data.playlists.map((playlist) => [playlist.id, playlist]));
  const collect = (page: ListPlaylistsData) => {
    for (const playlist of page.playlists) {
      if (!byId.has(playlist.id)) byId.set(playlist.id, playlist);
    }
  };
  let cursor: string | null = first.data.nextCursor;
  while (cursor) {
    const page = await listPlaylists({ ...pageOptions, cursor });
    if (!page.ok) return page;
    collect(page.data);
    cursor = page.data.nextCursor;
  }
  // The pages are keyed on activity, which only grows: a Playlist played or
  // edited while later pages load jumps above the cursor and no later page
  // holds it. It then sits on the first page, so one re-read catches it.
  const reread = await listPlaylists(pageOptions);
  if (!reread.ok) return reread;
  collect(reread.data);
  return { ok: true, data: { playlists: [...byId.values()], nextCursor: null } };
}

/** Create an empty user playlist. */
export function createPlaylist(name: string): Promise<ApiResult<CreatePlaylistData>> {
  return callApi<CreatePlaylistData>('/api/playlists', createPlaylistResponseSchema, {
    method: 'POST',
    body: { name },
  });
}

/** Rename a user playlist (Favorites refuses). */
export function renamePlaylist(
  playlistId: string,
  name: string,
): Promise<ApiResult<RenamePlaylistData>> {
  return callApi<RenamePlaylistData>('/api/playlists/rename', renamePlaylistResponseSchema, {
    method: 'POST',
    body: { playlistId, name },
  });
}

/** The Lounge share write: a non-null `audience` places the
 *  playlist In Lounge for that audience (or changes who it reaches), null
 *  returns it to Private. Curated user playlists only. */
export function sharePlaylist(
  playlistId: string,
  audience: ShareAudience | null,
): Promise<ApiResult<SharePlaylistData>> {
  return callApi<SharePlaylistData>('/api/playlists/share', sharePlaylistResponseSchema, {
    method: 'POST',
    body: { playlistId, audience },
  });
}

/** The share picker's read: the playlist's current audience plus every other
 *  User the owner may pick. */
export function getPlaylistShare(playlistId: string): Promise<ApiResult<PlaylistShareData>> {
  const params = new URLSearchParams({ playlistId });
  return callApi<PlaylistShareData>(
    `/api/playlists/share?${params.toString()}`,
    getPlaylistShareResponseSchema,
  );
}

/** The Library pin toggle: put an own playlist first in the
 *  caller's Playlists tab, or take it back out. Idempotent; another owner's and
 *  unknown ids answer the uniform 404. */
export function pinLibraryPlaylist(
  playlistId: string,
  pinned: boolean,
): Promise<ApiResult<PinPlaylistData>> {
  return callApi<PinPlaylistData>('/api/playlists/pin', pinPlaylistResponseSchema, {
    method: 'POST',
    body: { playlistId, pinned },
  });
}

/** The Lounge Pin toggle: put a playlist first in the
 *  caller's Lounge, or take it back out. Idempotent; Private and unknown ids
 *  answer the uniform 404. */
export function pinLoungePlaylist(
  playlistId: string,
  pinned: boolean,
): Promise<ApiResult<PinPlaylistData>> {
  return callApi<PinPlaylistData>('/api/lounge/pin', pinPlaylistResponseSchema, {
    method: 'POST',
    body: { playlistId, pinned },
  });
}

/** Admin moderation: return any In-Lounge playlist to Private. */
export function moderateLoungePlaylist(
  playlistId: string,
): Promise<ApiResult<ModerateLoungePlaylistData>> {
  return callApi<ModerateLoungePlaylistData>(
    '/api/lounge/moderate',
    moderateLoungePlaylistResponseSchema,
    { method: 'POST', body: { playlistId } },
  );
}

/** Delete a user playlist; sole-membership tracks return to Ephemeral. */
export function deletePlaylist(playlistId: string): Promise<ApiResult<DeletePlaylistData>> {
  return callApi<DeletePlaylistData>('/api/playlists/delete', deletePlaylistResponseSchema, {
    method: 'POST',
    body: { playlistId },
  });
}

/** Record that playlist playback engaged (drives the Playlists tab activity order). */
export function markPlaylistPlayed(playlistId: string): Promise<ApiResult<MarkPlaylistPlayedData>> {
  return callApi<MarkPlaylistPlayedData>(
    '/api/playlists/played',
    markPlaylistPlayedResponseSchema,
    { method: 'POST', body: { playlistId } },
  );
}

/** One playlist with its members in user order (position-keyset paging). */
export function getPlaylist(
  playlistId: string,
  cursor?: string | null,
  limit?: number,
): Promise<ApiResult<GetPlaylistData>> {
  const params = new URLSearchParams({ playlistId });
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return callApi<GetPlaylistData>(
    `/api/playlists/detail?${params.toString()}`,
    getPlaylistResponseSchema,
  );
}

/** One In-Lounge playlist as a Visitor reads it: the owner detail's
 *  page shape plus attribution; unknown/private/revoked ids answer the uniform 404. */
export function getLoungePlaylist(
  playlistId: string,
  cursor?: string | null,
  limit?: number,
): Promise<ApiResult<GetLoungePlaylistData>> {
  const params = new URLSearchParams({ playlistId });
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  return callApi<GetLoungePlaylistData>(
    `/api/lounge/playlist?${params.toString()}`,
    getLoungePlaylistResponseSchema,
  );
}

/** How a member surface fetches one page — the owner's detail endpoint by
 *  default, the Lounge read for a visitor surface. */
export type PlaylistPageFetcher = (
  cursor: string | null,
  limit: number,
) => Promise<ApiResult<GetPlaylistData>>;

/** Load a Playlist's complete ordered membership through its paginated endpoint —
 *  the curation and playback surfaces need every member, not a first page. */
export async function getAllPlaylistMembers(
  playlistId: string,
  fetchPage: PlaylistPageFetcher = (cursor, limit) => getPlaylist(playlistId, cursor, limit),
): Promise<ApiResult<GetPlaylistData>> {
  const first = await fetchPage(null, MAX_PLAYLIST_PAGE_LIMIT);
  if (!first.ok) return first;

  let { playlist, nextCursor: cursor } = first.data;
  const items = [...first.data.items];
  while (cursor) {
    const page = await fetchPage(cursor, MAX_PLAYLIST_PAGE_LIMIT);
    if (!page.ok) return page;
    // The last page answers with the freshest summary (counts move under paging).
    playlist = page.data.playlist;
    items.push(...page.data.items);
    cursor = page.data.nextCursor;
  }

  return { ok: true, data: { playlist, items, nextCursor: null } };
}

/** Append tracks to a playlist (idempotent per track; membership implies Save). */
export function addPlaylistTracks(
  playlistId: string,
  trackIds: string[],
): Promise<ApiResult<AddPlaylistTracksData>> {
  return callApi<AddPlaylistTracksData>(
    '/api/playlists/tracks/add',
    addPlaylistTracksResponseSchema,
    { method: 'POST', body: { playlistId, trackIds } },
  );
}

/** Remove one track from a playlist (last-membership removal unsaves). */
export function removePlaylistTrack(
  playlistId: string,
  trackId: string,
): Promise<ApiResult<RemovePlaylistTrackData>> {
  return callApi<RemovePlaylistTrackData>(
    '/api/playlists/tracks/remove',
    removePlaylistTrackResponseSchema,
    { method: 'POST', body: { playlistId, trackId } },
  );
}

/** Commit a whole playlist order (the reorder mode's single write). */
export function setPlaylistOrder(
  playlistId: string,
  trackIds: string[],
): Promise<ApiResult<SetPlaylistOrderData>> {
  return callApi<SetPlaylistOrderData>(
    '/api/playlists/tracks/order',
    setPlaylistOrderResponseSchema,
    { method: 'POST', body: { playlistId, trackIds } },
  );
}

/** The save picker's atomic commit: the track's FULL desired membership set
 *  (an empty set is Unsave), plus an optional inline new playlist. */
export function applyTrackMemberships(input: {
  trackId: string;
  playlistIds: string[];
  createPlaylistName?: string | null;
}): Promise<ApiResult<ApplyTrackMembershipsData>> {
  return callApi<ApplyTrackMembershipsData>(
    '/api/playlists/memberships/apply',
    applyTrackMembershipsResponseSchema,
    {
      method: 'POST',
      body: {
        trackId: input.trackId,
        playlistIds: input.playlistIds,
        createPlaylistName: input.createPlaylistName ?? null,
      },
    },
  );
}

/** Reserve one user-triggered Playlist cover generation attempt. */
export function regeneratePlaylistCover(
  input: RegeneratePlaylistCoverRequest,
): Promise<ApiResult<RegeneratePlaylistCoverData>> {
  return callApi<RegeneratePlaylistCoverData>(
    '/api/playlists/cover/regenerate',
    regeneratePlaylistCoverResponseSchema,
    { method: 'POST', body: input },
  );
}

/** Live attempt, usage budget, and re-selectable cover history for one playlist. */
export function playlistCoverStatus(
  playlistId: string,
  signal?: AbortSignal,
): Promise<ApiResult<PlaylistCoverStatusData>> {
  const params = new URLSearchParams({ playlistId });
  return callApi<PlaylistCoverStatusData>(
    `/api/playlists/cover/status?${params.toString()}`,
    playlistCoverStatusResponseSchema,
    { signal },
  );
}

/** Adopt a generated/uploaded cover, or clear back to the mosaic (null). */
export function selectPlaylistCover(
  playlistId: string,
  coverImageId: string | null,
): Promise<ApiResult<SelectPlaylistCoverData>> {
  return callApi<SelectPlaylistCoverData>(
    '/api/playlists/cover/select',
    selectPlaylistCoverResponseSchema,
    { method: 'POST', body: { playlistId, coverImageId } },
  );
}

/** Delete one cover from the playlist history (frees a history slot). */
export function deletePlaylistCover(
  playlistId: string,
  coverImageId: string,
): Promise<ApiResult<DeletePlaylistCoverData>> {
  return callApi<DeletePlaylistCoverData>(
    '/api/playlists/cover/delete',
    deletePlaylistCoverResponseSchema,
    { method: 'POST', body: { playlistId, coverImageId } },
  );
}

/** Upload a custom playlist cover (multipart; processed server-side to WebP). */
export function uploadPlaylistCover(
  playlistId: string,
  file: File,
): Promise<ApiResult<UploadPlaylistCoverData>> {
  const form = new FormData();
  form.set('playlistId', playlistId);
  form.set('file', file);
  return callApi<UploadPlaylistCoverData>(
    '/api/playlists/cover/upload',
    uploadPlaylistCoverResponseSchema,
    { method: 'POST', form },
  );
}

/** Fetch a single owned track's summary (flags + app-routed audio). */
export function getTrack(trackId: string): Promise<ApiResult<TrackData>> {
  return callApi<TrackData>(`/api/tracks/${encodeURIComponent(trackId)}`, getTrackResponseSchema);
}

/** Fetch a single owned track's lyric view (lines + sync state). */
export function getTrackLyrics(trackId: string): Promise<ApiResult<TrackLyrics>> {
  return callApi<TrackLyrics>(
    `/api/tracks/${encodeURIComponent(trackId)}/lyrics`,
    getTrackLyricsResponseSchema,
  );
}

/** Fetch a single owned track's descriptive data (the Track Data sheet). */
export function getTrackDetails(trackId: string): Promise<ApiResult<TrackDetails>> {
  return callApi<TrackDetails>(
    `/api/tracks/${encodeURIComponent(trackId)}/details`,
    getTrackDetailsResponseSchema,
  );
}

/** Start a NEW session seeded from existing track(s) (More Like This). */
export function moreLikeThis(
  seedTrackIds: string[],
  clientId: string,
  targetDurationMinutes?: number,
  /** What the new Session is about or for; it never changes the music. */
  context?: string,
): Promise<ApiResult<MoreLikeThisData>> {
  return callApi<MoreLikeThisData>('/api/sessions/more-like-this', moreLikeThisResponseSchema, {
    method: 'POST',
    body: {
      seedTrackIds,
      clientId,
      ...(targetDurationMinutes != null ? { targetDurationMinutes } : {}),
      ...(context ? { context } : {}),
    },
  });
}

/** The voice-profile endpoints all answer with the same safe view envelope;
 * method/body vary per action (JSON mutations, a multipart upload, DELETE). */
export function requestVoiceProfile(
  path: string,
  init?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    form?: FormData;
    signal?: AbortSignal;
  },
): Promise<ApiResult<VoiceProfileData>> {
  return callApi<VoiceProfileData>(path, voiceProfileResponseSchema, init);
}
