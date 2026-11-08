// Pure usage-limit math: the single reset-window
// calculation and the cost-limit chokepoint, shared by the worker buffer
// controller and the creation-time headroom gate. No DB dependency —
// callers pass counts in.

export { limitWindowStarts, type LimitWindowStarts } from './window';
export { DURATION_TARGET_REACHED_MESSAGE, isDurationTargetReached } from './session-duration';
export {
  boundedOrNull,
  boundWindow,
  checkCostLimits,
  evaluateCreationHeadroom,
  memberBoundScope,
  oneTimeBudgetUsedUpMessage,
  remainingHeadroomTracks,
  remainingInBound,
  type BoundWindow,
  type BoundWindows,
  type CostBound,
  type CostBounds,
  type CostLimitDecision,
  type CostLimitScope,
  type CostLimitWindow,
  type CreationHeadroomDecision,
  type MemberCostLimitScope,
} from './limits';
