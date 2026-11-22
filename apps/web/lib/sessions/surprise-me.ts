// Surprise Me: propose a vibe from the owner's learned taste, keep it
// as their one pending proposal, and buy nothing. Server-only.
//
// A proposal is a complete Style Snapshot — musical style plus lyric direction
// — produced by the same derivation Start Session uses, so starting it later
// needs no second expansion. With a text LLM configured that is two calls: one
// writes a fresh request from the chosen theme, the music learned taste picked,
// and the owner's city and country; the other expands it like a typed request,
// with no naming call. With none the plan's own request passes through to the
// music model as written, with its picks applied. The owner's own Person About may
// reach the expansion as lyric inspiration for a vocal proposal — never the
// request writer. Nothing else personal does.

import {
  getCachedLearnedTaste,
  getUsageLimits,
  getCoverArtSettings,
  getListenerContext,
  getPendingProposal,
  getProposalById,
  getProposalContext,
  listPeople,
  savePendingProposal,
  startProposalSession,
  type CreateSessionResult,
  type Database,
  type SurpriseProposalRow,
} from '@liedmotif/db';
import {
  ProviderError,
  sessionStyleSnapshotSchema,
  type SessionIntentInput,
  type SurpriseRequest,
} from '@liedmotif/providers';
import type {
  ListenerContext,
  SessionLanguage,
  StartSurpriseRequest,
  SurpriseProposal,
  SurpriseTheme,
  SurpriseVocal,
} from '@liedmotif/shared';
import {
  initialSessionCoverId,
  launchSessionCreationKickoffs,
  resolveCoverArtChoiceFrom,
} from '@/lib/covers/covers';
import { getLlmProvider } from '@/lib/providers/providers';
import { sessionCreateLimiter } from '../http/request-limits';
import {
  deriveSnapshotForIntentSafe,
  nameSessionSnapshot,
  newSessionTargetMinutes,
  sessionCreationRefusal,
  type SessionCreationRefusal,
} from './sessions';
import { planSurprise, type SurprisePlan } from './surprise-me-plan';

export function toSurpriseProposal(row: SurpriseProposalRow): SurpriseProposal {
  const { picks } = row;
  const { durationMinutes, situation: _situation, ...preview } = row.preview;
  return {
    id: row.id,
    adventurous: row.adventurous,
    skipProfile: row.skipProfile,
    ...preview,
    edit: {
      prompt: row.intent,
      genres: picks.genres ?? [],
      energy: picks.energy ?? null,
      vocal: picks.vocal ?? null,
      language: picks.language ?? null,
      durationMinutes: durationMinutes ?? null,
    },
  };
}

export async function loadPendingSurprise(
  db: Database,
  ownerUserId: string,
): Promise<SurpriseProposal | null> {
  const row = await getPendingProposal(db, ownerUserId);
  return row ? toSurpriseProposal(row) : null;
}

export type ProposeSurpriseResult =
  | { ok: true; proposal: SurpriseProposal }
  | ({ ok: false; reason: 'refused' } & SessionCreationRefusal)
  | { ok: false; reason: 'provider_error'; message: string }
  /** The tab's proposal is no longer the pending one; `retryable` when only the context moved. */
  | { ok: false; reason: 'stale'; message: string; retryable: boolean }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'cancelled'; message: string }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };

const STALE_MESSAGE = 'This suggestion was replaced somewhere else. Reload to see the current one.';
const CANCELLED_MESSAGE = 'The suggestion was cancelled.';
const CONTEXT_CHANGED_MESSAGE =
  'Your personalization changed while this was being prepared. Try again.';

/** Owners with a proposal being prepared: a double tap must not buy two text-LLM calls. */
const inFlight = new Set<string>();

/**
 * The profile context a proposal's expansion may see. The general profile is
 * what any Session gets; the owner's own About joins it for a vocal proposal,
 * as it does for every vocal Session, and never another Person's.
 */
async function surpriseListener(
  db: Database,
  ownerUserId: string,
  general: ListenerContext | null,
  plan: SurprisePlan,
): Promise<ListenerContext | null> {
  if (plan.picks.vocal !== 'vocal') return general;
  const self = (await listPeople(db, ownerUserId)).find((person) => person.role === 'owner');
  if (!self?.about.trim()) return general;
  return { ...(general ?? {}), about: self.about };
}

/** Start Session's gates: proposing and starting both refuse as it would. */
async function creationRefusal(db: Database, ownerUserId: string) {
  const refusal = await sessionCreationRefusal(db, ownerUserId);
  return refusal && { ok: false as const, reason: 'refused' as const, ...refusal };
}

export async function proposeSurprise(
  db: Database,
  input: {
    ownerUserId: string;
    adventurous: boolean;
    skipProfile: boolean;
    theme?: SurpriseTheme;
    vocal?: SurpriseVocal;
    language?: SessionLanguage;
    /** The pending proposal the caller is showing, or null for none. */
    replaces: string | null;
    /** The caller's request: once it aborts, the expansion stops and nothing is kept. */
    signal?: AbortSignal;
    random?: () => number;
  },
): Promise<ProposeSurpriseResult> {
  const { ownerUserId, adventurous, skipProfile, replaces } = input;

  // Every refusal that needs no model comes first, so none of them spends.
  const blocked = await creationRefusal(db, ownerUserId);
  if (blocked) return blocked;
  const context = await getProposalContext(db, ownerUserId);
  if (context.pendingId !== replaces) {
    return { ok: false, reason: 'stale', message: STALE_MESSAGE, retryable: false };
  }
  if (inFlight.has(ownerUserId)) return { ok: false, reason: 'busy' };
  inFlight.add(ownerUserId);
  try {
    const llm = await getLlmProvider();
    if (llm) {
      const admitted = sessionCreateLimiter.check(ownerUserId);
      if (!admitted.allowed) {
        return { ok: false, reason: 'rate_limited', retryAfterMs: admitted.retryAfterMs };
      }
    }

    const { resetTimezone } = await getUsageLimits(db);
    const taste = await getCachedLearnedTaste(db, {
      ownerUserId,
      now: new Date(),
      timezone: resetTimezone,
    });
    const general = skipProfile ? null : await getListenerContext(db, ownerUserId);
    const plan = planSurprise(taste, {
      adventurous,
      theme: input.theme,
      vocal: input.vocal,
      language: input.language,
      city: general?.city,
      replacing: context.pending?.situation,
      random: input.random ?? Math.random,
    });

    let written: SurpriseRequest = plan.request;
    if (llm) {
      const place = [general?.city, general?.country].filter(Boolean).join(', ');
      // The replaced request may name the owner's city; under Start without
      // profile it is withheld unless it was made without profile too.
      const avoid =
        context.pending && (!skipProfile || context.pending.skipProfile)
          ? context.pending.intent
          : undefined;
      try {
        written = await llm.createSurpriseRequest({
          ...plan.brief,
          ...(place ? { place } : {}),
          ...(avoid ? { avoid } : {}),
          ...(plan.picks.language ? { language: plan.picks.language } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        if (input.signal?.aborted)
          return { ok: false, reason: 'cancelled', message: CANCELLED_MESSAGE };
        if (err instanceof ProviderError)
          return { ok: false, reason: 'provider_error', message: err.message };
        throw err;
      }
    }
    const picks = { ...plan.picks, energy: written.energy };

    const listener =
      llm && !skipProfile ? await surpriseListener(db, ownerUserId, general, plan) : null;
    // With or without a text LLM the request is the music's direction: expanded,
    // or passed through to the music model as written.
    const intent: SessionIntentInput = { mode: 'prompt', prompt: written.request, ...picks };

    const derived = await deriveSnapshotForIntentSafe(intent, listener, {
      skipProfile,
      signal: input.signal,
    });
    // Cancel stops the expansion; a cancelled proposal is never kept, and saving
    // one would replace the proposal the tab still shows, making its next Try
    // another stale.
    if (input.signal?.aborted)
      return { ok: false, reason: 'cancelled', message: CANCELLED_MESSAGE };
    if (!derived.ok) return { ok: false, reason: 'provider_error', message: derived.message };

    // Own Voice is never chosen for the User, and an instrumental proposal
    // carries no lyric direction whatever the model returned.
    const snapshot = sessionStyleSnapshotSchema.parse({
      ...derived.snapshot,
      useOwnVoice: false,
      ...(derived.snapshot.vocalMode === 'vocal' ? {} : { lyricContext: '' }),
    });
    // Naming here is composition only: the expansion already named the proposal.
    const named = await nameSessionSnapshot(
      null,
      snapshot,
      null,
      { coverConcept: derived.coverConcept, autoCoverStyle: derived.autoCoverStyle },
      false,
    );

    const saved = await savePendingProposal(db, {
      ownerUserId,
      epoch: context.epoch,
      replaces,
      draft: {
        adventurous,
        skipProfile,
        llmGenerated: llm !== null,
        intent: written.request,
        picks,
        snapshot: named.snapshot,
        title: named.title,
        coverConcept: named.coverConcept,
        autoCoverStyle: named.autoCoverStyle,
        preview: {
          title: named.title,
          mood: snapshot.mood,
          genres: snapshot.genreTags,
          energy: snapshot.energy,
          vocalMode: snapshot.vocalMode,
          voiceGender: snapshot.voiceGender || null,
          language: snapshot.language || null,
          durationMinutes: written.durationMinutes,
          situation: plan.situation,
        },
      },
    });
    if (!saved.ok) {
      return saved.reason === 'context_changed'
        ? { ok: false, reason: 'stale', message: CONTEXT_CHANGED_MESSAGE, retryable: true }
        : { ok: false, reason: 'stale', message: STALE_MESSAGE, retryable: false };
    }
    return { ok: true, proposal: toSurpriseProposal(saved.proposal) };
  } finally {
    inFlight.delete(ownerUserId);
  }
}

export type StartSurpriseResult =
  | ({ ok: true } & CreateSessionResult)
  | ({ ok: false; reason: 'refused' } & SessionCreationRefusal)
  | { ok: false; reason: 'not_pending'; message: string }
  | { ok: false; reason: 'rate_limited'; retryAfterMs: number };

const NOT_PENDING_MESSAGE = 'This suggestion is no longer available. Ask for a new one.';

/**
 * Start the approved proposal as a Session through the normal creation path:
 * the same admission gates, replacement, Session duration rule, cover resolution and
 * kickoffs as Start Session, with the stored Style Snapshot in place of a
 * derivation — so no text LLM runs. A refusal leaves the proposal pending.
 */
export async function startSurprise(
  db: Database,
  input: { ownerUserId: string } & StartSurpriseRequest,
): Promise<StartSurpriseResult> {
  const { ownerUserId, proposalId } = input;
  const proposal = await getProposalById(db, { ownerUserId, proposalId });
  if (!proposal) return { ok: false, reason: 'not_pending', message: NOT_PENDING_MESSAGE };

  // A retry of a Start that already bought its Session buys nothing, so it
  // answers ahead of gates that could only refuse a new purchase.
  if (!proposal.startedSessionId) {
    const blocked = await creationRefusal(db, ownerUserId);
    if (blocked) return blocked;
    const admitted = sessionCreateLimiter.check(ownerUserId);
    if (!admitted.allowed) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: admitted.retryAfterMs };
    }
  }

  const [coverArtSettings, coverImageId, targetDurationMinutes] = await Promise.all([
    getCoverArtSettings(db, ownerUserId),
    initialSessionCoverId(db),
    newSessionTargetMinutes(db, ownerUserId, input.targetDurationMinutes),
  ]);
  const started = await startProposalSession(db, {
    ownerUserId,
    proposalId,
    session: {
      sessionMode: 'keep_going',
      coverImageId,
      // Start Session's rule: the no-LLM path keeps the image model out too.
      useStandardCover:
        input.useStandardCover ??
        (!proposal.llmGenerated ||
          (await getLlmProvider()) === null ||
          coverArtSettings.useStandardCoverArt),
      targetDurationMinutes,
      ...resolveCoverArtChoiceFrom(coverArtSettings.customStyleDefinition, input.coverStyle),
    },
  });
  if (!started.ok) return { ok: false, reason: 'not_pending', message: NOT_PENDING_MESSAGE };
  if (!started.alreadyStarted) await launchSessionCreationKickoffs(db, started.session);
  return { ok: true, session: started.session, supersededSessionId: started.supersededSessionId };
}
