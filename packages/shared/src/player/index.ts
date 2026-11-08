// Pure player-domain logic: live-blend math and the
// generation-controller status presentation. Framework- and DOM-free, so
// the player's thin Web Audio wiring stays untested-by-necessity while the math and
// the status copy carry full unit coverage.

export {
  beatPeriodSeconds,
  clamp,
  crossfadeStartSeconds,
  dbToGain,
  PRESERVED_PITCH_RATE_CAP,
  UNPRESERVED_PITCH_RATE_CAP,
  DEFAULT_CROSSFADE_SECONDS,
  DEFAULT_MAX_LUFS_GAIN_DB,
  DEFAULT_TARGET_LUFS,
  equalPowerFadeInCurve,
  equalPowerFadeOutCurve,
  equalPowerGains,
  gainToDb,
  loopSeam,
  loopSeamViable,
  lufsGainDb,
  MIN_LOOP_SEAM_BARS,
  MIN_LOOP_SEAM_TRACK_SECONDS,
  type LoopSeam,
} from './blend';

export {
  IDLE_LOOP_CONTROL,
  loopControlTransition,
  loopToggledOn,
  type LoopControlEvent,
  type LoopControlState,
  type LoopControlTransition,
  type LoopPin,
} from './loop-control';

export {
  headroomDb,
  mutualLoudnessGainsDb,
  soloLoudnessGainDb,
  TRUE_PEAK_CEILING_DB,
  type EdgeLoudness,
  type MutualLoudnessGains,
} from './edge-loudness';

export {
  decideEdge,
  DEFAULT_DRIFT_GUARD_FRACTION,
  type CommittedSourceKind,
  type EdgeDecision,
  type EdgeDegradeReason,
  type EdgeEndpoint,
  type EdgePolicyOptions,
  type EdgeTier,
} from './edge-policy';

export {
  beatAtOrBefore,
  contextTimeForMediaTime,
  planAlignedEdge,
  quantizedFadeBeats,
  upperEnvelopePositionSeconds,
  type AlignedEdgePlan,
  type BeatGrid,
} from './edge-schedule';

export {
  BUFFER_DEVICE_MEMORY_MIN_GB,
  bufferDeckTransition,
  bufferPositionSeconds,
  bufferTransportEligible,
  mediaSessionPositionState,
  type BufferDeckAction,
  type BufferDeckEvent,
  type BufferDeckState,
  type BufferDeckTransition,
  sectionLoopEligible,
  type BufferLoopRegion,
  type BufferPlaybackClock,
  type BufferTransportGateInputs,
  type MediaPositionState,
} from './buffer-transport';

export {
  pinnedSourceLadder,
  preparedDeckTransition,
  type PinnedAssets,
  type PinnedSourceStep,
  type PreparedDeckAction,
  type PreparedDeckEvent,
  type PreparedDeckState,
  type PreparedDeckTransition,
} from './prepared-deck';

export {
  COST_SETTINGS_PATH,
  MY_BUDGET_PATH,
  presentGenerationStatus,
  type GenerationStatusPresentation,
  type GenerationStatusTone,
  type QueueReadiness,
} from './generation-status';

export {
  PENDING_GENERATION_STAGES,
  pendingGenerationStage,
  stagedProgressCopy,
  type PendingGenerationStage,
} from './pending-generation';

export { resolveSeekTarget, SEEK_END_GUARD_SECONDS } from './seek-target';

export {
  nextPlaylistIndex,
  previousPlaylistIndex,
  reanchorPlaylistIndex,
  resolveInitialPlaylistIndex,
  type PlaylistCursor,
  type PlaylistCursorItem,
} from './resume-position';

export {
  PLAYBACK_MODES,
  commitShuffleTarget,
  createShuffleState,
  cyclePlaybackMode,
  peekShuffleTarget,
  popShuffleHistory,
  removeShuffleTrack,
  resolveOrderedNextIndex,
  syncShuffleState,
  type PlaybackMode,
  type ShuffleState,
  type ShuffleTarget,
} from './playback-mode';

export {
  deckEndedOutcome,
  type DeckEndedOutcome,
  type DeckPlaybackState,
  type PlayerDeckId,
} from './deck-ended';
export {
  SECTION_LOOP_END_MARGIN_SECONDS,
  SECTION_LOOP_MIN_SECONDS,
  snapLoopRegion,
  WAVEFORM_BAR_COUNT,
  waveformBars,
} from './section-loop';
