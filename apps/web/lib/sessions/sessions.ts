// Shared server helpers for the session API routes: the single Style-Snapshot
// derivation (the create-path producer wiring), the snapshot adapter to the DB
// jsonb shape, the creation-time headroom gate, and the `SessionRecord →
// sessionSummarySchema` mapping. Server-only — provider keys and the resolved LLM
// never leave this process.

import {
  CONTEXT_NAMING_FAILED,
  deriveSessionSnapshot,
  deriveSessionMetadata,
  deriveSessionTitle,
  inheritedGuardrails,
  ProviderConfigError,
  ProviderError,
  sessionStyleSnapshotSchema,
  type ExpansionOptions,
  type ListenerContext,
  type MusicProvider,
  type SessionIntentInput,
  type SessionStyleSnapshot,
  type VocalMode,
} from '@liedmotif/providers';
import {
  countTaskBounds,
  DecryptionError,
  EncryptionKeyError,
  getActiveSession,
  getAdminDisplayName,
  getGenerationSettings,
  getListenerContext,
  getSessionTrackActivity,
  getUsageLimits,
  listPeople,
  listPinnedSessions,
  listResumableSessions,
  mapScopeResults,
  MAX_PERSON_ABOUT_LENGTH,
  resolveBudgetScopes,
  type PersonRow,
  type ResumableSessionItem,
  type SessionRecord,
  type StyleSnapshot,
  type Database,
  type UsageLimits,
} from '@liedmotif/db';
import {
  boundedOrNull,
  boundWindow,
  checkCostLimits,
  createLogger,
  evaluateCreationHeadroom,
  matchConfiguredPeople,
  MAX_SESSION_TITLE_LENGTH,
  phantomSubmitCutoffAt,
  type ActiveSessionOverview,
  type BudgetKind,
  type CostBounds,
  type CostLimitDecision,
  type CoverStylePreset,
  type CreationHeadroomDecision,
  type SessionLanguage,
  type SessionListItem,
  type SessionSummary,
} from '@liedmotif/shared';
import { cache } from 'react';
import {
  creationHeadroomMessage,
  headroomBlockedMessage,
  newMusicPausedMessage,
} from '../budget/headroom-copy';
import { musicSetupMessage } from '../providers/music-setup-copy';
import { getLlmProvider, getMusicProvider } from '@/lib/providers/providers';
import { cachedUserProfile, requestNow } from '../request-cache';
import { providerTasksToTracks } from '../budget/track-units';

const logger = createLogger({ name: 'sessions' });

type PersonLyricSource = Pick<PersonRow, 'name' | 'nameMatchKey' | 'about' | 'role'> & {
  id: string;
};

type PersonMatchContext = Pick<ExpansionOptions, 'promptHistory'> & {
  /** The request's explicit vocal pick, when it carries one. */
  vocal?: VocalMode;
};

/** Nothing will be sung, so no About may go out: only an explicit Instrumental
 *  pick says so. The gate never reads the request's words, and a running
 *  instrumental Session does not shut it for a message: whether the words, in
 *  any language, ask for singing is the expansion's call, and it writes lyric
 *  notes only for a vocal Session (ADR 0004, ADR 0007). A picks-only change has
 *  no words, so its caller passes the running vocal mode when no pick is made. */
function vocalsRuledOut(context?: PersonMatchContext): boolean {
  return context?.vocal === 'instrumental';
}

/**
 * The About text a request's lyric notes may draw on, unless vocals are ruled
 * out. The owner's own About (`about`) goes with every such request, since each
 * Session is part of the listener's own soundtrack, whoever it names; the other
 * People's About (`people`) goes for each Person named by exact name. An
 * adjustment matches names over the change message AND the session's prompt
 * history, so People named only in an earlier request keep informing the edited
 * lyric notes. This About may reach the lyric notes and nothing else.
 */
export function personLyricContextForRequest(
  prompt: string,
  people: readonly PersonLyricSource[],
  context?: PersonMatchContext,
): { people: NonNullable<ListenerContext['people']>; about: string } {
  if (vocalsRuledOut(context)) return { people: [], about: '' };
  const owner = people.find((person) => person.role === 'owner');
  const about = owner ? clippedAbout(owner) : '';
  const named = context?.promptHistory ? `${prompt}\n${context.promptHistory}` : prompt;
  return {
    people: matchConfiguredPeople(named, people).flatMap((person) => {
      const personAbout = clippedAbout(person);
      return person.role !== 'owner' && personAbout
        ? [{ name: person.name, about: personAbout }]
        : [];
    }),
    about,
  };
}

function clippedAbout(person: PersonLyricSource): string {
  return person.about.trim().slice(0, MAX_PERSON_ABOUT_LENGTH);
}

/**
 * What the expansion may know about the listener and the People the request
 * names. A Session run without the profile leaves out everything that is the
 * owner's own — their profile, their About, their Person — and keeps the other
 * People it names: those are the request's, not the profile's.
 */
async function listenerContextForIntent(
  db: Database,
  ownerUserId: string,
  input: SessionIntentInput,
  options?: ExpansionOptions,
): Promise<ListenerContext | null> {
  const skipProfile = options?.skipProfile === true;
  const general = skipProfile ? null : await getListenerContext(db, ownerUserId);
  if (input.mode === 'controls') return general;
  // A picks-only change has no words that could ask for singing, so without a
  // vocal pick the running Session's vocal mode stands.
  const vocal =
    input.mode === 'picks' ? (input.vocal ?? options?.adjustFrom?.vocalMode) : input.vocal;
  const context: PersonMatchContext = { ...options, vocal };
  if (vocalsRuledOut(context)) return general;
  const everyone = await listPeople(db, ownerUserId);
  // A picks-only change has no message: People are matched over the history alone.
  const { people, about } = personLyricContextForRequest(
    input.mode === 'prompt' ? input.prompt : '',
    skipProfile ? everyone.filter((person) => person.role !== 'owner') : everyone,
    context,
  );
  if (people.length === 0 && !about) return general;
  return {
    ...(general ?? {}),
    ...(people.length > 0 ? { people } : {}),
    ...(about ? { about } : {}),
  };
}

/**
 * The Session duration target a new Session starts with, on every start path:
 * a number in the request; an explicit null in the request is No limit; with
 * nothing in the request, the duration the text LLM read from the prompt
 * (Start Session only), and otherwise the user's Default Session duration.
 */
export async function newSessionTargetMinutes(
  db: Database,
  ownerUserId: string,
  requested: number | null | undefined,
  fromPrompt?: number | null,
): Promise<number | null> {
  if (requested !== undefined) return requested;
  if (fromPrompt != null) return fromPrompt;
  return (await getGenerationSettings(db, ownerUserId)).defaultSessionDurationMinutes;
}

/**
 * Derive the session's ONE Style Snapshot from its intent. The text LLM is resolved
 * (env → DB) ONLY for the free-text path, and is optional even there: without one,
 * free text compiles via the deterministic prompt passthrough, structured controls
 * via the template, so the create flow works with none
 * configured. Per-track generation later reuses the persisted snapshot with no
 * further LLM call. The listener profile context (Settings → Profile) reaches only
 * the LLM path.
 */
export async function deriveSnapshotForIntent(
  input: SessionIntentInput,
  listener?: ListenerContext | null,
): Promise<SessionStyleSnapshot> {
  const llm = input.mode === 'prompt' ? await getLlmProvider() : null;
  return deriveSessionSnapshot(input, llm, listener);
}

/** The text LLM rewords a free-text or picks-only intent; controls never reach it. */
async function deriveMetadataForIntent(
  input: SessionIntentInput,
  listener?: ListenerContext | null,
  expansion?: ExpansionOptions,
) {
  const llm = input.mode === 'controls' ? null : await getLlmProvider();
  return deriveSessionMetadata(input, llm, listener, expansion);
}

/**
 * Outcome of deriving a snapshot for a create/restyle route: the derived snapshot,
 * or the one expected failure surfaced as a discriminated reason the route maps to
 * a contract error envelope — a sanitized provider failure from the expansion
 * (`provider_error`, its message already user-safe). Any other derivation failure
 * propagates as a thrown error (an unexpected 500). Keeps the handling — identical
 * across Start Session and Change Vibe — in one place.
 */
export type DerivedSnapshotResult =
  | {
      ok: true;
      snapshot: SessionStyleSnapshot;
      coverConcept: string;
      autoCoverStyle: CoverStylePreset | null;
      requestedDurationMinutes?: number | null;
      includesListener: boolean;
    }
  | { ok: false; reason: 'llm_expansion_failed'; message: string };

/** Derive a snapshot, mapping the expected failure (see {@link DerivedSnapshotResult}). */
export async function deriveSnapshotForIntentSafe(
  input: SessionIntentInput,
  listener?: ListenerContext | null,
  expansion?: ExpansionOptions,
): Promise<DerivedSnapshotResult> {
  try {
    return { ok: true, ...(await deriveMetadataForIntent(input, listener, expansion)) };
  } catch (err) {
    if (err instanceof ProviderError) {
      // The message is sanitized for the user; `safeDetail` carries the loggable
      // non-secret cause (error name / HTTP status / timeout flag) so a failed
      // expansion is diagnosable from the server log.
      logger.warn('LLM session-intent expansion failed', {
        providerErrorName: err.name,
        ...err.safeDetail,
      });
      return { ok: false, reason: 'llm_expansion_failed', message: err.message };
    }
    throw err;
  }
}

/**
 * Adapt the provider snapshot (frozen `bpm: number | null`) to the DB jsonb
 * `StyleSnapshot` shape (`bpm?: number`). The frozen BPM is always a number after
 * derivation; this only narrows the type so the column write type-checks.
 */
export function toStoredSnapshot(snapshot: SessionStyleSnapshot): StyleSnapshot {
  return { ...snapshot, bpm: snapshot.bpm ?? undefined };
}

/**
 * What the text LLM wrote for a Session's cover: the visual concept and the
 * preset Auto resolves to (ADR 0007). Each comes from the expansion, or from the
 * naming call where the expansion left it empty.
 */
interface CoverDirection {
  coverConcept: string;
  autoCoverStyle: CoverStylePreset | null;
}

const NO_COVER_DIRECTION: CoverDirection = { coverConcept: '', autoCoverStyle: null };

/**
 * Fill the snapshot's creative naming (session Name proposal + track-title pool)
 * when a text LLM is configured and the snapshot lacks it — the structured-controls
 * and More Like This paths; the free-text expansion already returns both in its one
 * call, so it short-circuits here. Never fails creation: `createSessionMetadata`
 * never throws and is bounded by a short timeout (a slow model delays the create
 * request by at most that budget), returning empty metadata on failure; with no
 * LLM the snapshot returns unchanged. Either way `deriveSessionTitle` composes the
 * deterministic Name from an unnamed snapshot (the text LLM stays
 * optional).
 */
async function withCreativeNaming(
  userPrompt: string | null,
  snapshot: SessionStyleSnapshot,
  existing: CoverDirection,
  listener?: ListenerContext | null,
  options?: {
    allowNamingCall?: boolean;
    /** Names the proposal must stay clear of (a seeded session's source names). */
    avoidTitles?: string[];
  },
): Promise<{ snapshot: SessionStyleSnapshot } & CoverDirection> {
  const unchanged = { snapshot, ...existing };
  if (snapshot.title.trim() && snapshot.trackTitles.length > 0) return unchanged;
  if (options?.allowNamingCall === false) return unchanged;
  try {
    const llm = await getLlmProvider();
    if (!llm) return unchanged;
    const naming = await llm.createSessionMetadata({
      userPrompt,
      snapshot,
      listener,
      avoidTitles: options?.avoidTitles,
    });
    return {
      snapshot: {
        ...snapshot,
        title: snapshot.title.trim() ? snapshot.title : naming.title,
        trackTitles: snapshot.trackTitles.length > 0 ? snapshot.trackTitles : naming.trackTitles,
        lyricContext: snapshot.lyricContext || naming.lyricContext,
      },
      coverConcept: existing.coverConcept || naming.coverConcept,
      autoCoverStyle: existing.autoCoverStyle ?? naming.autoCoverStyle,
    };
  } catch (err) {
    // Naming is cosmetic and must never fail creation — that covers the
    // provider SETUP too (e.g. a misconfigured credential key), not just the
    // bounded naming call. Degrade to the deterministic composition.
    logger.warn('creative naming unavailable; using deterministic naming', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return unchanged;
  }
}

/** A session's stored jsonb snapshot paired with its display Name. */
export interface NamedSnapshot {
  snapshot: StyleSnapshot;
  title: string;
  coverConcept: string | null;
  autoCoverStyle: CoverStylePreset | null;
}

/**
 * Produce a create/restyle path's stored snapshot + display Name in one step: fill
 * creative naming when a text LLM is configured, then adapt to the DB jsonb shape and
 * compose the Name from the (possibly LLM-named) snapshot. Shared verbatim by Start
 * Session and Change Vibe.
 */
export async function nameSessionSnapshot(
  userPrompt: string | null,
  snapshot: SessionStyleSnapshot,
  listener?: ListenerContext | null,
  existing: CoverDirection = NO_COVER_DIRECTION,
  allowNamingCall = true,
): Promise<NamedSnapshot> {
  const named = await withCreativeNaming(userPrompt, snapshot, existing, listener, {
    allowNamingCall,
  });
  return {
    snapshot: toStoredSnapshot(named.snapshot),
    title: deriveSessionTitle({ userPrompt, snapshot: named.snapshot }),
    coverConcept: named.coverConcept || null,
    autoCoverStyle: named.autoCoverStyle,
  };
}

/**
 * The whole create/restyle derivation in ONE step: load the owner's listener
 * context (Settings → Profile) once, derive the Style Snapshot from the intent,
 * and — on success — fill creative naming. Routes call this and never handle the
 * listener themselves; personalization stays an implementation detail of
 * derivation. Expected failures pass through from `deriveSnapshotForIntentSafe`.
 */
export type DerivedNamedSnapshot =
  | ({
      ok: true;
      userPrompt: string | null;
      requestedDurationMinutes?: number | null;
      /** The request puts the listener in its scene; the Session's cover reads it. */
      includesListener: boolean;
    } & NamedSnapshot)
  | Extract<DerivedSnapshotResult, { ok: false }>;

/** A Change Vibe adjustment keeps the running session's creative naming: the
 * Name is never touched and the track-title pool follows it — only
 * the vibe changes. Vocal lyric notes survive too, unless the adjustment went
 * instrumental or the expansion wrote new ones. Preserving the pool here also
 * makes `withCreativeNaming` short-circuit, so no re-naming call runs. */
function withPreservedNaming(
  next: SessionStyleSnapshot,
  current: SessionStyleSnapshot,
): SessionStyleSnapshot {
  return {
    ...next,
    title: current.title.trim() ? current.title : next.title,
    trackTitles: current.trackTitles.length > 0 ? current.trackTitles : next.trackTitles,
    lyricContext: next.lyricContext || (next.vocalMode === 'vocal' ? current.lyricContext : ''),
  };
}

export async function deriveNamedSnapshotForIntent(
  db: Database,
  ownerUserId: string,
  input: SessionIntentInput,
  options?: ExpansionOptions,
): Promise<DerivedNamedSnapshot> {
  const listener = await listenerContextForIntent(db, ownerUserId, input, options);
  const derived = await deriveSnapshotForIntentSafe(input, listener, options);
  if (!derived.ok) return derived;
  const userPrompt = input.mode === 'prompt' ? input.prompt : null;
  const snapshot = options?.adjustFrom
    ? withPreservedNaming(derived.snapshot, options.adjustFrom)
    : derived.snapshot;
  const named = await nameSessionSnapshot(
    userPrompt,
    snapshot,
    listener,
    { coverConcept: derived.coverConcept, autoCoverStyle: derived.autoCoverStyle },
    input.mode === 'controls',
  );
  return {
    ok: true,
    userPrompt,
    ...named,
    requestedDurationMinutes: derived.requestedDurationMinutes,
    includesListener: derived.includesListener,
  };
}

/**
 * Keep a seeded session's Name off its source's. The avoid list handed to the
 * naming call is prompt guidance only, and the deterministic composition has no
 * such steer at all: identical vibe fields compose the identical Name, so a
 * deterministically-named source would be cloned outright. The one backstop
 * behind both paths — a sequel suffix, trimmed to fit the Name length.
 */
function distinguishFromSourceTitle(title: string, sourceTitle: string): string {
  if (title.trim().toLowerCase() !== sourceTitle.trim().toLowerCase()) return title;
  const suffixed = `${title} II`;
  if (suffixed.length <= MAX_SESSION_TITLE_LENGTH) return suffixed;
  return `${title.slice(0, MAX_SESSION_TITLE_LENGTH - 3).trimEnd()} II`;
}

/**
 * Strip a FOREIGN More Like This seed of the sharer's personal ingredients:
 * `useOwnVoice` falls back to the generic vocal pick the snapshot
 * already carries (`vocalMode`/`voiceGender` survive — the worker must never
 * resolve the VISITOR's voice profile for the SHARER's intent), and the
 * sharer's personal lyric notes — where their People live — are dropped so the
 * seeded naming call may fill fresh ones from the visitor's own profile. Every
 * other field is the musical identity the visitor is entitled to reuse.
 */
export function stripPersonalIngredients(seed: StyleSnapshot): StyleSnapshot {
  return { ...seed, useOwnVoice: false, lyricContext: '' };
}

type SeededNaming = { snapshot: SessionStyleSnapshot; includesListener: boolean } & CoverDirection;

/**
 * The naming a seed without a context gets: cosmetic, with the owner's listener
 * context, and deterministic when no text LLM answers. It reads nothing that
 * could place the listener in a scene.
 */
async function plainSeededNaming(
  db: Database,
  ownerUserId: string,
  snapshot: SessionStyleSnapshot,
  avoidTitles: string[],
): Promise<SeededNaming> {
  const listener = await getListenerContext(db, ownerUserId);
  const named = await withCreativeNaming(null, snapshot, NO_COVER_DIRECTION, listener, {
    avoidTitles,
  });
  return { ...named, includesListener: false };
}

/** What a More Like This adds to its seed: a context, a language pick, or
 *  both. Either one makes the seeded naming call required. */
export interface SeededRewrite {
  context: string | null;
  language: SessionLanguage | null;
}

/**
 * The naming a More Like This context or language pick gets: the one seeded
 * naming call, made required. A context is its listening request and the seed's
 * lyric notes the direction it edits; its activity answer replaces the seed's.
 * A pick alone rewrites the seed's names and lyric notes in that language. The
 * new lyric notes replace the seed's, and the language becomes the pick, else on
 * Auto Detect the context's language as the call read it, else the seed's: the
 * one music field this may change. With a context the listener and People reach
 * the call as they reach a Start Session expansion of the same words, with the
 * seed's vocal mode as the vocal pick. Throws `ProviderError` when there is no
 * usable Name and title pool, or a vocal seed gets no lyric notes it needs, so
 * no Session ignores what was asked.
 */
async function rewrittenNaming(
  db: Database,
  ownerUserId: string,
  { context, language }: SeededRewrite,
  snapshot: SessionStyleSnapshot,
  avoidTitles: string[],
): Promise<SeededNaming> {
  const listener = context
    ? await listenerContextForIntent(db, ownerUserId, {
        mode: 'prompt',
        prompt: context,
        vocal: snapshot.vocalMode,
      })
    : await getListenerContext(db, ownerUserId);
  const llm = await getLlmProvider();
  if (!llm) throw new ProviderConfigError('More Like This with a context needs a text AI.');
  const naming = await llm.createSessionMetadata({
    snapshot,
    listener,
    avoidTitles,
    context,
    language,
  });
  const vocal = snapshot.vocalMode === 'vocal';
  // A vocal Session's lyrics follow its lyric notes alone, so notes missing
  // from the answer would leave them ignoring the context, or in the seed's
  // language under a pick.
  const needsNotes = vocal && (Boolean(context) || Boolean(snapshot.lyricContext.trim()));
  if (
    !naming.title.trim() ||
    naming.trackTitles.length === 0 ||
    (needsNotes && !naming.lyricContext.trim())
  ) {
    throw new ProviderError(CONTEXT_NAMING_FAILED, { failure: 'unusable_response' });
  }
  return {
    snapshot: {
      ...snapshot,
      title: naming.title,
      trackTitles: naming.trackTitles,
      lyricContext: vocal ? naming.lyricContext : '',
      activity: context ? (naming.activity ?? '') : snapshot.activity,
      language: language || (context ? naming.language : '') || snapshot.language,
    },
    coverConcept: naming.coverConcept,
    autoCoverStyle: naming.autoCoverStyle,
    includesListener: context ? naming.includesListener === true : false,
  };
}

/**
 * Name a More Like This session seeded from a stored jsonb snapshot. The seed
 * arrives WITH its source session's creative naming, which must not be cloned —
 * the source's title and pool are cleared and passed as taken instead, so one
 * short-timeout naming call (when configured, with the owner's listener context)
 * proposes related-but-different names; deterministic composition otherwise.
 * Naming is merged onto the ORIGINAL seed so every stored field zod would strip
 * is preserved; a seed that fails to parse keeps its stored naming.
 *
 * With a context or a language pick the naming call is required
 * (`rewrittenNaming`): it throws a `ProviderError` the route answers as a
 * retryable error, and a missing text LLM throws `ProviderConfigError` (the
 * route refuses that case before calling).
 *
 * The Guardrails are the one part of the vibe the seed does not simply carry
 * over: they are re-stamped, so a pre-guardrails source still starts a new
 * Session with concrete values.
 */
export async function nameSeededSnapshot(
  db: Database,
  ownerUserId: string,
  seed: StyleSnapshot,
  rewrite: SeededRewrite = { context: null, language: null },
): Promise<NamedSnapshot & { includesListener: boolean }> {
  const rewrites = Boolean(rewrite.context || rewrite.language);
  const parsed = sessionStyleSnapshotSchema.safeParse(seed);
  if (!parsed.success) {
    // A seed that does not parse keeps its stored naming, which would ignore a
    // context or a pick; with one, that is a failed naming like any other.
    if (rewrites) throw new ProviderError(CONTEXT_NAMING_FAILED, { failure: 'unreadable_seed' });
    return {
      snapshot: seed,
      title: deriveSessionTitle({ snapshot: seed }),
      coverConcept: null,
      autoCoverStyle: null,
      includesListener: false,
    };
  }
  const inherited = inheritedGuardrails(parsed.data);
  const unnamed = { ...parsed.data, ...inherited, title: '', trackTitles: [] };
  const avoidTitles = [parsed.data.title, ...parsed.data.trackTitles].filter(
    (title) => title.trim().length > 0,
  );
  const named = rewrites
    ? await rewrittenNaming(db, ownerUserId, rewrite, unnamed, avoidTitles)
    : await plainSeededNaming(db, ownerUserId, unnamed, avoidTitles);
  return {
    snapshot: {
      ...seed,
      ...inherited,
      title: named.snapshot.title,
      trackTitles: named.snapshot.trackTitles,
      lyricContext: named.snapshot.lyricContext,
      ...(rewrites ? { activity: named.snapshot.activity, language: named.snapshot.language } : {}),
    },
    title: distinguishFromSourceTitle(
      deriveSessionTitle({ snapshot: named.snapshot }),
      deriveSessionTitle({ snapshot: parsed.data }),
    ),
    coverConcept: named.coverConcept || null,
    autoCoverStyle: named.autoCoverStyle,
    includesListener: named.includesListener,
  };
}

/**
 * Count the owner's spent tasks once per budget scope that binds them, over
 * the windows of each scope's kind. The shared read behind every
 * cost decision — the creation headroom gate, the dislike-reroll budget, the
 * diagnostics usage readout — so which bounds apply is `resolveBudgetScopes`'
 * answer and no caller re-derives it. The owner's OWN bound is always first.
 */
async function loadCostBounds(
  db: Database,
  ownerUserId: string,
  now: Date,
  knownLimits?: UsageLimits,
): Promise<{ limits: UsageLimits; bounds: CostBounds }> {
  const limits = knownLimits ?? (await getUsageLimits(db));
  const budget = await resolveBudgetScopes(db, {
    ownerUserId,
    instanceLimits: limits,
    // The guard already resolved the requester this request; share that read.
    knownProfile: await cachedUserProfile(db, ownerUserId),
  });
  // Every scope's counts in ONE statement. The app shell refetches this on
  // every navigation and the Pool scope spans all Members, so counting each
  // scope's windows separately means a Member pays four aggregate scans — one
  // of them cross-user — per navigation.
  const counted = await countTaskBounds(db, {
    scopes: budget.scopes,
    now,
    resetTimezone: limits.resetTimezone,
    // Only the spend counts bind here; concurrency slots are the worker's
    // question, so this cutoff just satisfies the shared primitive.
    phantomSubmitCutoff: phantomSubmitCutoffAt(now),
  });
  return { limits, bounds: mapScopeResults(counted, (scope) => scope.bound) };
}

/**
 * The creation-time headroom gate: count the owner's spent tasks in the
 * current day/month windows and decide whether a new session may be created. Spend
 * is counted internally in provider calls (tasks) but the threshold is expressed in
 * TRACKS (Suno yields 2/call). Resume is NEVER routed through this gate.
 */
export async function evaluateSessionHeadroom(
  db: Database,
  ownerUserId: string,
  now: Date = new Date(),
  /** Stored limits the caller already read — one settings read per request. */
  knownLimits?: UsageLimits,
  /** The music provider the caller already built. */
  knownMusic?: MusicProvider,
): Promise<CreationHeadroomDecision> {
  const { limits, bounds } = await loadCostBounds(db, ownerUserId, now, knownLimits);
  const music = knownMusic ?? (await getMusicProvider());
  const tracksPerCall = music.getCapabilities().typicalTracksPerRequest;
  // The threshold stays the instance value for every role — it is not a
  // per-Member knob.
  return evaluateCreationHeadroom(bounds, tracksPerCall, limits.minHeadroomTracksToStartSession);
}

/**
 * Whether the owner could spend ONE more music-model call right now, and which
 * scope and window refuse it when not — the cost-limit chokepoint the worker
 * applies at submit, read against the same bounds so a caller never admits
 * what the worker (or the Pool) would refuse. Change Vibe is gated on this
 * rather than the creation headroom: its revision fill needs one call, not a
 * Session's worth of Tracks to Repeat. Nothing is spent here.
 */
export async function evaluateGenerationBudget(
  db: Database,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<CostLimitDecision> {
  const { bounds } = await loadCostBounds(db, ownerUserId, now);
  return checkCostLimits(bounds);
}

/**
 * `evaluateGenerationBudget` as a yes/no. The Dislike route uses this only to
 * REPORT the reroll's `replacementSource` (`generation` vs `none`) — the reroll
 * top-up itself is performed by the worker buffer controller through the same
 * money gate, so usage limits are enforced in exactly one place.
 */
export async function ownerHasGenerationBudget(
  db: Database,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await evaluateGenerationBudget(db, ownerUserId, now)).withinLimits;
}

/**
 * The owner's usage in user-facing TRACK units (tasks counted internally, shown in
 * tracks), for the minimal diagnostics route. Safe: counts only, never
 * a secret.
 */
export async function getOwnerUsageTracks(
  db: Database,
  ownerUserId: string,
  tracksPerCall: number,
  now: Date = new Date(),
  knownLimits?: UsageLimits,
): Promise<{
  dailyTracksUsed: number;
  /** `null` when the window is unbounded: the Admin with the Track ceiling off. */
  dailyTracksLimit: number | null;
  monthlyTracksUsed: number;
  monthlyTracksLimit: number | null;
  minHeadroomTracksToStartSession: number;
  budgetKind: BudgetKind;
}> {
  const { limits, bounds } = await loadCostBounds(db, ownerUserId, now, knownLimits);
  // The owner's OWN bound: the instance budget for the Admin, their personal one
  // for a Member — never the shared Pool, which is not theirs to read as usage.
  // The readout is shaped for a rolling budget's two windows; a One-time budget
  // has only its total, which stands in for both — so the kind travels with the
  // figures, or a reader cannot tell a resetting window from a pot that never
  // refills.
  const { windows } = bounds[0];
  const day = boundWindow(windows, 'day');
  const month = boundWindow(windows, 'month');
  const trackLimit = (cap: number) => boundedOrNull(providerTasksToTracks(cap, tracksPerCall));
  return {
    dailyTracksUsed: providerTasksToTracks(day.used, tracksPerCall),
    dailyTracksLimit: trackLimit(day.cap),
    monthlyTracksUsed: providerTasksToTracks(month.used, tracksPerCall),
    monthlyTracksLimit: trackLimit(month.cap),
    minHeadroomTracksToStartSession: limits.minHeadroomTracksToStartSession,
    budgetKind: windows[0].window === 'total' ? 'oneTime' : 'rolling',
  };
}

/**
 * Request-scoped `getOwnerUsageTracks`: the app layout, the settings hub, and
 * the chrome route share ONE budget computation per request — on the shared
 * request clock, so no two readouts in a render can straddle a window boundary.
 * Keyed by the db handle like every request-cached read (see `request-cache`).
 */
export const cachedOwnerUsageTracks = cache(
  async (db: Database, ownerUserId: string, tracksPerCall: number) =>
    getOwnerUsageTracks(db, ownerUserId, tracksPerCall, requestNow()),
);

/**
 * The refusal a blocked headroom or generation-budget decision is answered
 * with. A creation headroom decision carries its numbers, so its text names
 * them, the reset in the Instance timezone and, when waiting cannot help, the
 * Admin. A generation-budget refusal fires only when not one call fits, so it
 * says used up, and only a One-time budget (the `total` window — always a
 * Member's own) needs the Admin's name.
 */
export async function headroomRefusalMessage(
  db: Database,
  decision: CreationHeadroomDecision | Pick<CreationHeadroomDecision, 'scope' | 'window'>,
): Promise<string> {
  if ('remainingTracks' in decision) {
    const [adminName, limits] = await Promise.all([getAdminDisplayName(db), getUsageLimits(db)]);
    return creationHeadroomMessage(decision, { adminName, resetTimezone: limits.resetTimezone });
  }
  const adminName = decision.window === 'total' ? await getAdminDisplayName(db) : null;
  return headroomBlockedMessage(decision, adminName);
}

/**
 * Why a request for new music is refused while the Admin has paused all new
 * music, in the words the requester sees; null while it is not paused. A free
 * read, so every door answers it before the creation rate limit and before its
 * budget gate: a budget reset would not lift a pause.
 */
export async function newMusicPausedRefusal(
  db: Database,
  ownerUserId: string,
  /** Stored limits the caller already read — one settings read per request. */
  knownLimits?: UsageLimits,
): Promise<string | null> {
  const limits = knownLimits ?? (await getUsageLimits(db));
  if (!limits.manualGenerationOnly) return null;
  const profile = await cachedUserProfile(db, ownerUserId);
  if (profile?.role !== 'member') return newMusicPausedMessage({ role: 'admin' });
  return newMusicPausedMessage({ role: 'member', adminName: await getAdminDisplayName(db) });
}

/**
 * The active music provider, or why it cannot be built from its configuration
 * in the words the requester sees: no key anywhere, a stored key that cannot be
 * read (wrong or missing `CREDENTIAL_ENCRYPTION_KEY`), or an unknown
 * `MUSIC_PROVIDER`. Any other failure is rethrown. The log gets the error's
 * class only: its text can name the configuration.
 */
async function musicProviderOrRefusal(
  db: Database,
  ownerUserId: string,
): Promise<{ music: MusicProvider } | { refusal: string }> {
  try {
    return { music: await getMusicProvider() };
  } catch (error) {
    const configuration =
      error instanceof ProviderConfigError ||
      error instanceof DecryptionError ||
      error instanceof EncryptionKeyError;
    if (!configuration) throw error;
    logger.warn('music provider is not configured; new Session refused', {
      errorName: error.name,
    });
    const profile = await cachedUserProfile(db, ownerUserId);
    return { refusal: musicSetupMessage(profile?.role === 'member' ? 'member' : 'admin') };
  }
}

/** A refused new Session: the API error it answers with, and the words the requester sees. */
export interface SessionCreationRefusal {
  code: 'new_music_paused' | 'provider_error' | 'session_headroom_blocked';
  message: string;
}

/**
 * Why a new Session would be refused right now, whichever door starts it
 * (Start Session, More Like This, Surprise Me, the Assistant's cards); null
 * when it would not. Paused new music answers first, since a budget reset
 * would not lift it, then a music provider that cannot be built (fixing the
 * key is the only way out, so it is not retryable), then the creation
 * headroom. Free reads, nothing spent.
 */
export async function sessionCreationRefusal(
  db: Database,
  ownerUserId: string,
): Promise<SessionCreationRefusal | null> {
  const limits = await getUsageLimits(db);
  const paused = await newMusicPausedRefusal(db, ownerUserId, limits);
  if (paused) return { code: 'new_music_paused', message: paused };
  const provider = await musicProviderOrRefusal(db, ownerUserId);
  if ('refusal' in provider) return { code: 'provider_error', message: provider.refusal };
  const headroom = await evaluateSessionHeadroom(
    db,
    ownerUserId,
    undefined,
    limits,
    provider.music,
  );
  if (headroom.allowed) return null;
  return { code: 'session_headroom_blocked', message: await headroomRefusalMessage(db, headroom) };
}

/** Map a `SessionRecord` to the contract `sessionSummarySchema` payload. */
export function toSessionSummary(session: SessionRecord): SessionSummary {
  return {
    id: session.id,
    status: session.status,
    title: session.title,
    generationStatus: session.generationStatus,
    generationStatusScope: session.generationStatusScope,
    sessionMode: session.sessionMode,
    targetDurationMinutes: session.targetDurationMinutes,
    generatedDurationSeconds: session.generatedDurationSeconds ?? 0,
    unknownDurationTrackCount: session.unknownDurationTrackCount ?? 0,
    coverImageId: session.coverImageId,
    statusMessageSafe: session.statusMessageSafe,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

/**
 * The My Sessions list (resumable Stopped sessions + optionally the live active
 * Session overview) as the contract shape. Shared by `GET /api/sessions` and
 * the server renders of Home and My Sessions, so their first paint carries the
 * same data the client hook later revalidates over HTTP.
 */
export async function loadSessionList(
  db: Database,
  ownerUserId: string,
  args: { cursor?: string | null; limit: number; includeActive: boolean; includePinned: boolean },
): Promise<{
  items: SessionListItem[];
  nextCursor: string | null;
  activeSession: ActiveSessionOverview | null;
  pinned: SessionListItem[];
}> {
  const [{ items, nextCursor }, activeSession, pinned] = await Promise.all([
    listResumableSessions(db, {
      ownerUserId,
      cursor: args.cursor ?? null,
      limit: args.limit,
      // Pinned Sessions move into their own section, so the paged list skips them.
      excludePinned: args.includePinned,
    }),
    args.includeActive ? getActiveSession(db, { ownerUserId }) : Promise.resolve(null),
    args.includePinned ? listPinnedSessions(db, { ownerUserId }) : Promise.resolve([]),
  ]);
  const activeSessionActivity = activeSession
    ? await getSessionTrackActivity(db, { ownerUserId, sessionId: activeSession.id })
    : null;
  return {
    items: items.map(toSessionListItem),
    nextCursor,
    activeSession:
      activeSession && activeSessionActivity
        ? { ...toSessionSummary(activeSession), ...activeSessionActivity }
        : null,
    pinned: pinned.map(toSessionListItem),
  };
}

function toSessionListItem(item: ResumableSessionItem): SessionListItem {
  return {
    id: item.id,
    title: item.title,
    coverImageId: item.coverImageId,
    lastActiveAt: item.lastActiveAt.toISOString(),
    status: item.status,
    trackCount: item.trackCount,
    totalDurationSeconds: item.totalDurationSeconds,
    genreTags: item.genreTags,
    pinned: item.pinned,
  };
}
