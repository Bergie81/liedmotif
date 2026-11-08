// Sanity ceilings on the cost limits, shared by every budget that spends the
// providers: the instance `usageLimits` the Admin edits, and the Invite Mode
// Member and Members Pool budgets. Cost controls are on by default
// and the app spends real money per generation, so a limit stored above anything
// spend can ever reach is the controls switched off — one API call, or one form
// bug, away. Every ceiling below sits far above any plausible personal instance:
// the job is refusing nonsense, not second-guessing the operator, and 0 ("none
// at all") stays valid on every key but the floors below.
//
// Counted in provider TASKS, shown to humans in Tracks (2 per Suno call) — the
// standing convention, so a task ceiling reads as twice as many Tracks in the UI.

export const USAGE_LIMIT_CEILINGS = {
  /** A task every ~2 minutes around the clock; 40× the shipped default. */
  dailyGenerationTasks: 1_000,
  /** The daily ceiling on every day of the longest month, so any daily cap in
   *  force can always be paired with a monthly one above it. */
  monthlyGenerationTasks: 31_000,
  /** The documented provider guidance is 20 requests / 10 s. More in flight than
   *  that buys provider errors, not a faster queue. */
  maxConcurrentJobs: 20,
  /** How deep the Queue may run ahead of the player. It is only ever compared
   *  against `bufferAheadTracks`, whose own range tops out at 10. */
  maxQueuedTracks: 100,
  /** A week. Idle auto-stop is a spend guard; beyond this it stops guarding. */
  idleAutoStopAfterMinutes: 7 * 24 * 60,
  /** The Tracks a window's REMAINING budget must still cover before a Session
   *  may start. Far above this it stops guarding a nearly-spent budget and
   *  simply refuses to start anything. */
  minHeadroomTracksToStartSession: 100,
  /** 1 PiB. No self-hosted volume comes near it, and the free-space check
   *  already bounds a quota that overshoots the actual disk. */
  storageQuotaBytes: 1024 ** 5,
  /** Cover art is cosmetic image-provider spend, capped like the task windows. */
  generatedCoversPerDay: 1_000,
  generatedCoversPerMonth: 31_000,
} as const;

/** A cost-limit field that carries a ceiling. */
export type UsageLimitCeilingField = keyof typeof USAGE_LIMIT_CEILINGS;

/** The numeric limit fields the settings UI can edit — every key with a ceiling. */
export const NUMERIC_LIMIT_KEYS = Object.keys(
  USAGE_LIMIT_CEILINGS,
) as readonly UsageLimitCeilingField[];

/**
 * The smallest value a limit accepts, when it is above 0. A concurrency of 0
 * lets no provider call start, so a Session waits for its first Track forever
 * and nothing says why; a Track budget of 0 is the way to stop generation. A
 * queue depth of 0 cannot mean "nothing queued": it only zeroes the Buffer
 * watermark, while a Change Vibe revision's fill and a Dislike reroll still
 * generate. An idle auto-stop of 0 minutes would stop every active Session,
 * playing or not, on the next sweep.
 */
const USAGE_LIMIT_FLOORS: Partial<Record<UsageLimitCeilingField, number>> = {
  maxConcurrentJobs: 1,
  maxQueuedTracks: 1,
  idleAutoStopAfterMinutes: 1,
};

/** The smallest value a cost-limit field accepts. */
export function usageLimitFloor(field: UsageLimitCeilingField): number {
  return USAGE_LIMIT_FLOORS[field] ?? 0;
}
