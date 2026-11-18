// Generation-controller query layer. Thin Drizzle reads/writes the worker
// buffer controller and the API routes consume; the decision logic lives
// in the worker, the limit math in `@liedmotif/shared`. Kept in `@liedmotif/db` so
// both apps reuse one query surface (mirrors `covers/repo`, `credentials/repo`).

export {
  insertGeneratedTrack,
  writeTrackAnalysis,
  resetUnavailableTrackAnalyses,
  listTracksNeedingAnalysis,
  countTracksByAnalysisStatus,
  getTrackForAnalysis,
  getReadableTrackPlaybackAudio,
  getTrackForDownload,
  writeDownloadedTrackAudio,
  withTrackDownloadLock,
  claimSessionAudioFolder,
  renameTrack,
  type InsertGeneratedTrackInput,
  type GeneratedTrackAudio,
  type AnalysisAudioRef,
  type TrackForAnalysis,
  type WriteTrackAnalysisInput,
  type ReadableTrackPlaybackAudio,
  type TrackForDownload,
  type WriteDownloadedTrackAudioInput,
} from './tracks-repo';

export {
  EPHEMERAL_EVICTION_REASON,
  ORPHAN_CLEANUP_REASON,
  sweepOrphanedTracks,
} from './eviction-repo';

export {
  deleteTrack,
  deleteTrackInTx,
  USER_DELETE_REASON,
  type DeleteTrackResult,
} from './delete-track-repo';

export {
  queueTrackAudioDeletion,
  queueOrphanedDownloadDeletion,
  queueStorageObjectDeletion,
  queueOwnerStorageObjectDeletion,
  listDueDeletionQueueItems,
  markDeletionQueueItemProcessed,
  recordDeletionQueueItemFailure,
  ORPHANED_DOWNLOAD_REASON,
  type DueDeletionQueueItem,
} from './deletion-queue-repo';

export {
  listActiveSessionsForSweep,
  stopSessionFromWorker,
  getSessionForBuffer,
  lockSessionForBuffer,
  setGenerationStatus,
  countReadyAheadTracks,
  countInFlightSessionJobs,
  countSessionGenerationRequests,
  countSessionOwnReadyTracks,
  getBufferSessionCounts,
  getRecentLyricBriefs,
  appendSessionTrackTitles,
  listSessionLoopCandidates,
  getEarliestReadySessionMusicTaskId,
  getLatestProviderJobState,
  type BufferSessionCounts,
  type SweepSession,
  type BufferSession,
} from './sessions-repo';

export {
  acquireMembersPoolLock,
  countInFlightTasks,
  countSpendAndInFlightForScopes,
  countTasksInWindow,
  countTasksInWindowByOwner,
  withOwnerGenerationLock,
  type ScopeSpendAndInFlight,
  type ScopeSpendWindows,
} from './limits-repo';

export {
  findUnplayedSibling,
  getTrackRerollContext,
  markTrackRerollPending,
  peekPendingRerollIdentity,
  clearPendingRerolls,
  consumePendingReroll,
  type RerollIdentity,
} from './reroll-repo';

// The repeat-one loop lease: the acknowledged acquire/renew/release state
// machine + the sweep predicate (consumed by the buffer sweep).
export {
  applyLoopLease,
  hasLiveLoopLease,
  type ApplyLoopLeaseResult,
  type LoopLeaseState,
  type OwnLoopLease,
} from './loop-lease-repo';

export {
  insertSubmittingGenerationJob,
  markProviderJobSubmitted,
  parkUnsubmittedProviderJob,
  recordProviderTaskIdFailSafe,
  updateRequestStyleSnapshot,
  type InsertSubmittingGenerationJobInput,
  type UnsubmittedJobOutcome,
} from './submit-repo';

export { recordUsageEvent, type RecordUsageEventInput } from './usage-repo';

export {
  countProviderJobUrlAssets,
  getProviderJobForPoll,
  updateProviderJobPollState,
  bumpProviderJobPollAttempt,
  markGenerationRequestFailed,
  failFinalLessTracksOfJob,
  listDuePollJobs,
  listReadyJobsMissingTracks,
  listLiveProviderTrackIds,
  listTimedOutJobsAwaitingFinals,
  type ProviderJobForPoll,
  type UpdateProviderJobPollStateInput,
} from './provider-poll-repo';

export {
  recordEarlyTrackTitle,
  upsertProviderTrackWithAssets,
  type ProviderTrackUpsertContext,
  type ProviderTrackUpsertInput,
  type ProviderTrackUpsertResult,
} from './provider-results-repo';

export { encryptSourceUrl, decryptSourceUrl } from './source-url-crypto';

export {
  getReadableTrackLyricsContext,
  saveTrackLyrics,
  saveTrackTimedLyrics,
  type ReadableTrackLyricsContext,
} from './lyrics-repo';

export { getReadableTrackDetails, type ReadableTrackDetails } from './track-details-repo';

// Download-route selections: one owned track's local final / a session's
// play-ordered zippable set.
export {
  getOwnedDownloadableTrack,
  getOwnedSessionDownloadTracks,
  type DownloadableTrack,
} from './download-tracks-repo';

export { listGivenUpSavedDownloads, PROVIDER_FINAL_RETENTION_MS } from './given-up-downloads-repo';

// ID3 tag context (worker retag + download-time staleness check) and the
// (re)tag fan-out reads for `embed-track-metadata`.
export {
  getTrackForMetadataEmbed,
  listTracksForMetadataEmbed,
  listFinalMp3TrackIdsForSession,
  listFinalMp3TrackIdsForOwner,
  updateLocalOriginalByteSize,
} from './metadata-repo';

// Best-effort Graphile enqueue from the web process (cover generation, retags).
export {
  addWorkerJob,
  addWorkerJobBatch,
  PLAYLIST_COVER_JOB_IDENTIFIER,
  playlistCoverJobKey,
  SESSION_BUFFER_JOB_IDENTIFIER,
  SESSION_COVER_JOB_IDENTIFIER,
  SESSION_COVER_JOB_MAX_ATTEMPTS,
  sessionBufferJobKey,
  sessionCoverJobKey,
  TRACK_EMBED_QUEUE_NAME,
  type AddWorkerJobOptions,
} from './worker-jobs';

// Listener feedback + library: track-flag writes
// (save/favorite), the dislike reroll/reject path, the audit-event write, and the
// owner-scoped library/track reads.
export {
  rejectDislikedTrack,
  rejectDislikedTrackInTx,
  recordFeedbackEvent,
  getLibraryTracks,
  getOwnedTrackSummary,
  REJECT_PURGE_REASON,
  REJECT_GRACE_MS,
  type TrackFlagsResult,
  type TrackFlagWriteResult,
  type RejectDislikedTrackResult,
  type LibraryTrack,
  type OwnedTrackSummary,
  type LibraryView as LibraryTrackView,
  type GetLibraryTracksResult,
} from './feedback-repo';

// The strict cursor codec shared by every keyset-paged route (Library, My
// Sessions) — routes validate with `parseKeysetCursor` before the value can
// reach the raw keyset SQL casts.
export {
  parseKeysetCursor,
  type KeysetCursor,
  type ParseKeysetCursorResult,
} from './keyset-cursor';

export {
  deleteSession,
  finishDeferredSessionDeletes,
  type DeleteSessionResult,
} from './session-delete-repo';

export {
  createSession,
  stopSession,
  playSessionTrack,
  resumeSession,
  tryAgainSession,
  type TryAgainSessionResult,
  restyleSession,
  renameSession,
  setSessionMode,
  setSessionDuration,
  getSessionById,
  lockSessionForCoverPlanning,
  getActiveSession,
  getSeedSnapshot,
  type SeedSnapshotResult,
  reportPlaybackState,
  type SessionRecord,
  type CreateSessionInput,
  type CreateSessionResult,
  type PlaySessionTrackResult,
  type ResumeSessionResult,
  type RestyleSessionResult,
  type ReportPlaybackStateInput,
  type ReportPlaybackStateResult,
} from './session-command-repo';

export {
  listPinnedSessions,
  listResumableSessions,
  type ResumableSessionItem,
  type ListResumableSessionsResult,
} from './session-list-repo';

export { setSessionPinned, type SetSessionPinnedResult } from './session-pin-repo';

export {
  getSessionTrackActivity,
  getSessionTrackActivities,
  type SessionTrackActivity,
} from './session-activity-repo';

// The server-authoritative queue view.
export {
  getSessionQueue,
  type QueueSessionRecord,
  type QueueSessionStyleFacets,
  type SessionQueuePendingGeneration,
  type SessionQueueView,
  type SessionQueueItemRecord,
  type SessionQueueTrack,
} from './queue-view-repo';
export { performVibeSwitchCutover } from './vibe-switch-repo';
export {
  getPlayableTrackSession,
  hasPlayableSessionTrack,
  listSessionTracks,
} from './session-tracks-repo';
export {
  getSessionDurationProgress,
  listSessionTracksMissingDuration,
  markSessionDurationBatchMaterialized,
  writeMeasuredTrackDuration,
} from './session-duration-repo';
