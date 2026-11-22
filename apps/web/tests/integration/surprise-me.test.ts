import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import {
  pendingSurpriseResponseSchema,
  proposeSurpriseResponseSchema,
  startSessionResponseSchema,
  type ListenerContext,
} from '@liedmotif/shared';
import type { SurpriseRequestInput } from '@liedmotif/providers';
import {
  createPerson,
  ensureOwnerPerson,
  getPendingProposal,
  getSessionById,
  EMPTY_LISTENER_PROFILE,
  getListenerProfile,
  resetLearnedTaste,
  updateGenerationSettings,
  updateListenerProfile,
  updatePerson,
  updateUsageLimits,
  type Database,
} from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { ProviderError } from '@liedmotif/providers';

// Surprise Me proposals: two bounded text-LLM calls per admitted
// proposal, a persisted owner-scoped preview, and nothing bought by previewing.

interface Expansion {
  intent: string;
  listener: ListenerContext | null;
  picks: unknown;
  skipProfile: boolean | undefined;
}

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llmConfigured: true,
  expansions: [] as Expansion[],
  requests: [] as SurpriseRequestInput[],
  writerFails: false,
  otherLlmCalls: 0,
  /** Runs inside the expansion, before it answers. */
  duringExpansion: null as null | ((signal?: AbortSignal) => Promise<void>),
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  const other = () => {
    holder.otherLlmCalls += 1;
  };
  const capturing: typeof llm = {
    ...llm,
    async expandSessionIntentWithMetadata(intent, listener, picks, options) {
      holder.expansions.push({
        intent,
        listener: listener ?? null,
        picks,
        skipProfile: options?.skipProfile,
      });
      await holder.duringExpansion?.(options?.signal);
      return llm.expandSessionIntentWithMetadata(intent, listener, picks, options);
    },
    async createSurpriseRequest(input) {
      holder.requests.push(input);
      if (holder.writerFails) throw new ProviderError('The text LLM could not write a surprise.');
      return llm.createSurpriseRequest(input);
    },
    async expandSessionIntent(...args) {
      other();
      return llm.expandSessionIntent(...args);
    },
    async createSessionMetadata(input) {
      other();
      return llm.createSessionMetadata(input);
    },
    async createTrackLyricBrief(input) {
      other();
      return llm.createTrackLyricBrief(input);
    },
  };
  return {
    getLlmProvider: async () => (holder.llmConfigured ? capturing : null),
    getMusicProvider: () => music,
  };
});

const route = await import('@/app/api/surprise-me/route');
const startRoute = await import('@/app/api/surprise-me/start/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
const db = () => testDb.db as Database;

function call(method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal) {
  const handler = route[method] as (request: Request) => Promise<Response>;
  return handler(
    new Request('http://localhost/api/surprise-me', {
      method,
      signal,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );
}

async function propose(body: Record<string, unknown> = {}) {
  const res = await call('POST', { replaces: null, ...body });
  return proposeSurpriseResponseSchema.parse(await res.json());
}

async function proposeOk(body: Record<string, unknown> = {}) {
  const parsed = await propose(body);
  if (!parsed.ok) throw new Error(`proposal refused: ${parsed.error.code}`);
  return parsed.data.proposal;
}

async function start(proposalId: string, extra: Record<string, unknown> = {}) {
  const res = await startRoute.POST(
    new Request('http://localhost/api/surprise-me/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalId, ...extra }),
    }),
  );
  return startSessionResponseSchema.parse(await res.json());
}

async function startOk(proposalId: string, extra: Record<string, unknown> = {}) {
  const parsed = await start(proposalId, extra);
  if (!parsed.ok) throw new Error(`start refused: ${parsed.error.code}`);
  return parsed.data;
}

async function pending() {
  const parsed = pendingSurpriseResponseSchema.parse(await (await call('GET')).json());
  if (!parsed.ok) throw new Error('pending read failed');
  return parsed.data.proposal;
}

/** Three Favorites' worth of vocal German indie: confident learned taste. */
async function teachVocalTaste(ownerUserId: string) {
  for (let i = 0; i < 3; i += 1) {
    await testDb.pool.query(
      `insert into taste_evidence (owner_user_id, analytics_track_id, kind, genre_tags, energy, vocal_mode, language)
       values ($1, gen_random_uuid(), 'favorite', '["indie"]'::jsonb, 'medium', 'vocal', 'German')`,
      [ownerUserId],
    );
  }
}

async function purchases() {
  const count = async (table: string) =>
    Number((await testDb.pool.query(`select count(*) from ${table}`)).rows[0].count);
  return {
    sessions: await count('activity_sessions'),
    requests: await count('generation_requests'),
    providerJobs: await count('provider_jobs'),
    covers: await count('session_cover_generations'),
    workerJobs: await count('graphile_worker._private_jobs'),
  };
}
const NOTHING_BOUGHT = { sessions: 0, requests: 0, providerJobs: 0, covers: 0, workerJobs: 0 };

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('surprise-me-test');
  holder.db = testDb.db;
  await runMigrations({ connectionString: TEST_DATABASE_URL });
}, 60_000);
afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});
beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'surprise_proposals',
    'taste_evidence',
    'listening_preferences',
    'user_settings',
    'people',
    ...GENERATION_FIXTURE_TABLES,
    'app_settings',
  ]);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  holder.ownerUserId = await createUser(testDb.db);
  holder.llmConfigured = true;
  holder.expansions = [];
  holder.requests = [];
  holder.writerFails = false;
  holder.otherLlmCalls = 0;
  holder.duringExpansion = null;
});

describe.skipIf(skip)('Surprise Me proposals', () => {
  it('writes a fresh request, expands it like a typed one, and buys nothing', async () => {
    const proposal = await proposeOk({ theme: 'morning' });

    expect(holder.requests).toHaveLength(1);
    expect(holder.requests[0]!.subject).toMatch(/morning/i);
    expect(holder.expansions).toHaveLength(1);
    const written = holder.expansions[0]!.intent;
    expect(written).toBe(`${holder.requests[0]!.subject} — ${holder.requests[0]!.music}.`);
    expect(proposal.edit.prompt).toBe(written);
    expect(holder.otherLlmCalls).toBe(0);
    expect(await purchases()).toEqual(NOTHING_BOUGHT);
    // A new User with no learned taste gets an instrumental proposal.
    expect(proposal.vocalMode).toBe('instrumental');
    expect(proposal.adventurous).toBe(false);
    expect(proposal.genres.length).toBeGreaterThan(0);

    // Survives navigation: a later read returns the same preview, with no call.
    expect(await pending()).toEqual(proposal);
    expect(holder.expansions).toHaveLength(1);
  });

  it('exposes only the public preview', async () => {
    const proposal = await proposeOk();
    expect(Object.keys(proposal).sort()).toEqual(
      [
        'adventurous',
        'edit',
        'energy',
        'genres',
        'id',
        'language',
        'mood',
        'skipProfile',
        'title',
        'vocalMode',
        'voiceGender',
      ].sort(),
    );
    const stored = await getPendingProposal(db(), holder.ownerUserId!);
    expect(stored?.snapshot.stylePrompt).toBeTruthy();
    expect(stored?.llmGenerated).toBe(true);
  });

  it('Try another writes a request that steers away from the one it replaces', async () => {
    const first = await proposeOk();
    const second = await proposeOk({ replaces: first.id, adventurous: true });

    expect(second.id).not.toBe(first.id);
    expect(second.adventurous).toBe(true);
    expect(holder.requests.map((input) => input.avoid)).toEqual([undefined, first.edit.prompt]);
    expect(holder.expansions).toHaveLength(2);
    expect((await pending())?.id).toBe(second.id);
  });

  it('a failing text LLM is a retryable error that keeps the previous proposal', async () => {
    const first = await proposeOk();
    holder.duringExpansion = async () => {
      throw new ProviderError('The text LLM did not answer. Try again.');
    };

    const failed = await propose({ replaces: first.id });
    expect(failed).toMatchObject({ ok: false, error: { code: 'provider_error', retryable: true } });
    expect(await pending()).toEqual(first);
  });

  it('a failing text LLM is never replaced by a deterministic proposal', async () => {
    holder.duringExpansion = async () => {
      throw new ProviderError('The text LLM did not answer. Try again.');
    };
    expect((await propose()).ok).toBe(false);
    expect(await pending()).toBeNull();
  });

  it('a failing request writer is a retryable error, with no expansion and no fallback', async () => {
    holder.writerFails = true;
    expect(await propose()).toMatchObject({
      ok: false,
      error: { code: 'provider_error', retryable: true },
    });
    expect(holder.expansions).toHaveLength(0);
    expect(await pending()).toBeNull();
  });

  it('proposes deterministically when no text LLM is configured', async () => {
    holder.llmConfigured = false;
    const proposal = await proposeOk();

    expect(holder.requests).toHaveLength(0);
    expect(holder.expansions).toHaveLength(0);
    expect(proposal.vocalMode).toBe('instrumental');
    expect(proposal.title.trim()).not.toBe('');
    expect((await getPendingProposal(db(), holder.ownerUserId!))?.llmGenerated).toBe(false);
    expect(await purchases()).toEqual(NOTHING_BOUGHT);
  });

  it('without a text LLM the proposal’s situation reaches the music, not only the preview', async () => {
    holder.llmConfigured = false;
    await proposeOk({ theme: 'place' });

    const stored = (await getPendingProposal(db(), holder.ownerUserId!))!;
    const situation = stored.intent.split(' — ')[0]!;
    expect((stored.snapshot.stylePrompt ?? '').toLowerCase()).toContain(situation.toLowerCase());
  });

  it('Try another never hands the request writer the topic it replaces', async () => {
    for (let i = 0; i < 6; i += 1) {
      const current = await pending();
      await proposeOk({ replaces: current?.id ?? null });
    }
    const subjects = holder.requests.map((input) => input.subject);
    for (let i = 1; i < subjects.length; i += 1) expect(subjects[i]).not.toBe(subjects[i - 1]);
  });

  it('refuses without Start Session headroom, before any text-LLM call', async () => {
    await updateUsageLimits(db(), {
      dailyGenerationTasks: 2,
      monthlyGenerationTasks: 400,
      minHeadroomTracksToStartSession: 100,
      resetTimezone: 'UTC',
    });

    const refused = await propose();
    expect(refused).toMatchObject({ ok: false, error: { code: 'session_headroom_blocked' } });
    expect(holder.requests).toHaveLength(0);
    expect(holder.expansions).toHaveLength(0);
    expect(await pending()).toBeNull();
  });

  describe('About context', () => {
    const OWN_ABOUT = 'Grew up sailing on the Baltic. Loves thunderstorms.';
    const OTHER_ABOUT = 'Anna collects vintage synthesizers.';

    beforeEach(async () => {
      if (skip) return;
      const ownerUserId = holder.ownerUserId!;
      const self = await ensureOwnerPerson(db(), ownerUserId);
      await updatePerson(db(), {
        ownerUserId,
        personId: self.id,
        name: self.name,
        about: OWN_ABOUT,
      });
      await createPerson(db(), { ownerUserId, name: 'Anna', about: OTHER_ABOUT });
      await teachVocalTaste(ownerUserId);
    });

    it('offers only the owner’s own About, for a vocal proposal, and keeps it server-side', async () => {
      const proposal = await proposeOk();

      expect(proposal.vocalMode).toBe('vocal');
      expect(proposal.language).toBe('German');
      const [expansion] = holder.expansions;
      expect(expansion!.listener?.about).toBe(OWN_ABOUT);
      expect(expansion!.listener?.people).toBeUndefined();
      expect((expansion!.picks as { ownVoice?: boolean }).ownVoice).toBeUndefined();
      // The request writer, the request text and the preview carry no About content.
      expect(JSON.stringify(holder.requests)).not.toMatch(/Baltic|Anna/);
      expect(expansion!.intent).not.toContain('Baltic');
      expect(JSON.stringify(proposal)).not.toContain('Baltic');

      const stored = await getPendingProposal(db(), holder.ownerUserId!);
      expect(stored).toMatchObject({ skipProfile: false });
      expect(stored?.intent).not.toContain('Baltic');
      expect(stored?.snapshot.useOwnVoice ?? false).toBe(false);
    });

    it('the request writer sees the owner’s city and country, and nothing under Start without profile', async () => {
      const ownerUserId = holder.ownerUserId!;
      const profile = (await getListenerProfile(db(), ownerUserId)) ?? EMPTY_LISTENER_PROFILE;
      await updateListenerProfile(db(), ownerUserId, {
        ...profile,
        city: 'Hamburg',
        country: 'Germany',
      });

      await proposeOk();
      await proposeOk({ replaces: (await pending())!.id, skipProfile: true });
      await proposeOk({ replaces: (await pending())!.id, skipProfile: true });
      expect(holder.requests.map((input) => input.place)).toEqual([
        'Hamburg, Germany',
        undefined,
        undefined,
      ]);
      // The replaced request may name the city: withheld unless it was made without profile too.
      expect(holder.requests.map((input) => input.avoid === undefined)).toEqual([
        true,
        true,
        false,
      ]);
    });

    it('the request is written in the Session language the proposal picked', async () => {
      await proposeOk({ language: 'Spanish' });
      await proposeOk({ replaces: (await pending())!.id });
      expect(holder.requests.map((input) => input.language)).toEqual(['Spanish', 'German']);
      expect((holder.expansions[1]!.picks as { language?: string }).language).toBe('German');
    });

    it('Start without profile reads no profile or People, while taste still applies', async () => {
      const proposal = await proposeOk({ skipProfile: true });

      expect(proposal.vocalMode).toBe('vocal');
      expect(holder.expansions[0]).toMatchObject({ listener: null, skipProfile: true });
      const stored = await getPendingProposal(db(), holder.ownerUserId!);
      expect(stored).toMatchObject({ skipProfile: true });
    });

    it('never offers About for an instrumental proposal', async () => {
      await resetLearnedTaste(db(), { ownerUserId: holder.ownerUserId! });
      await proposeOk();
      expect(holder.expansions[0]!.listener?.people ?? []).toEqual([]);
    });
  });

  it('a stale tab cannot replace a proposal it is not showing, and spends nothing trying', async () => {
    const first = await proposeOk();
    const second = await proposeOk({ replaces: first.id });
    holder.expansions = [];

    const stale = await propose({ replaces: first.id });
    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(holder.expansions).toHaveLength(0);
    expect((await pending())?.id).toBe(second.id);

    const dismissStale = await call('DELETE', { proposalId: first.id });
    expect(dismissStale.status).toBe(404);
    expect((await pending())?.id).toBe(second.id);
  });

  it('a reset while the text LLM is answering discards the late result', async () => {
    holder.duringExpansion = () => resetLearnedTaste(db(), { ownerUserId: holder.ownerUserId! });

    const late = await propose();
    expect(late).toMatchObject({ ok: false, error: { code: 'conflict', retryable: true } });
    expect(await pending()).toBeNull();
  });

  it('a cancelled proposal keeps nothing, so the tab can ask again', async () => {
    const tab = new AbortController();
    holder.duringExpansion = async () => tab.abort();

    const res = await call('POST', { replaces: null }, tab.signal);
    expect(proposeSurpriseResponseSchema.parse(await res.json())).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(await pending()).toBeNull();
    holder.duringExpansion = null;
    expect((await propose()).ok).toBe(true);
  });

  it('Cancel stops the text-LLM call, so a new proposal is admitted at once', async () => {
    const tab = new AbortController();
    holder.duringExpansion = (signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener('abort', () => reject(new ProviderError('aborted'))),
      );

    const cancelled = call('POST', { replaces: null }, tab.signal);
    await vi.waitFor(() => expect(holder.expansions).toHaveLength(1));
    tab.abort();
    expect(proposeSurpriseResponseSchema.parse(await (await cancelled).json())).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });

    holder.duringExpansion = null;
    expect((await propose()).ok).toBe(true);
  });

  it('admits one proposal at a time per owner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    holder.duringExpansion = () => gate;

    const first = propose();
    await vi.waitFor(() => expect(holder.expansions).toHaveLength(1));
    const second = await propose();
    release();

    expect(second).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect((await first).ok).toBe(true);
    expect(holder.expansions).toHaveLength(1);
  });

  it('is private to its owner and dismissible by them', async () => {
    const proposal = await proposeOk();
    const owner = holder.ownerUserId;

    holder.ownerUserId = await createUser(testDb.db);
    expect(await pending()).toBeNull();
    expect((await call('DELETE', { proposalId: proposal.id })).status).toBe(404);

    holder.ownerUserId = owner;
    expect((await call('DELETE', { proposalId: proposal.id })).status).toBe(200);
    expect(await pending()).toBeNull();
  });

  describe('starting the approved proposal', () => {
    const blockHeadroom = () =>
      updateUsageLimits(db(), {
        dailyGenerationTasks: 2,
        monthlyGenerationTasks: 400,
        minHeadroomTracksToStartSession: 100,
        resetTimezone: 'UTC',
      });

    it('a proposal made without a text LLM starts prompt-born, so Change Vibe keeps its situation', async () => {
      holder.llmConfigured = false;
      const proposal = await proposeOk({ theme: 'place' });
      const { session } = await startOk(proposal.id);

      const stored = await getSessionById(db(), {
        ownerUserId: holder.ownerUserId!,
        sessionId: session.id,
      });
      expect(stored).toMatchObject({ userPrompt: proposal.edit.prompt, structuredControls: null });
    });

    it('starts exactly the approved style and lyric direction, with no second expansion', async () => {
      await teachVocalTaste(holder.ownerUserId!);
      const proposal = await proposeOk();
      const approved = (await getPendingProposal(db(), holder.ownerUserId!))!;

      const { session } = await startOk(proposal.id, { targetDurationMinutes: 45 });

      expect(holder.expansions).toHaveLength(1);
      expect(holder.otherLlmCalls).toBe(0);
      const stored = await getSessionById(db(), {
        ownerUserId: holder.ownerUserId!,
        sessionId: session.id,
      });
      expect(stored?.sessionStyleSnapshot).toEqual(approved.snapshot);
      expect(stored?.sessionStyleSnapshot?.vocalMode).toBe('vocal');
      expect(stored).toMatchObject({
        status: 'active',
        title: approved.title,
        userPrompt: approved.intent,
        targetDurationMinutes: 45,
      });
      // The normal creation kickoffs ran: the initial fill and the cover.
      expect((await purchases()).workerJobs).toBeGreaterThan(0);
      expect(await pending()).toBeNull();
    });

    it('carries the text LLM’s Auto cover pick from the proposal onto the Session', async () => {
      const proposal = await proposeOk();
      const approved = (await getPendingProposal(db(), holder.ownerUserId!))!;
      expect(approved.autoCoverStyle).toBe('photographic');

      const { session } = await startOk(proposal.id);
      const stored = await getSessionById(db(), {
        ownerUserId: holder.ownerUserId!,
        sessionId: session.id,
      });
      expect(stored).toMatchObject({
        coverConcept: approved.coverConcept,
        autoCoverStyle: 'photographic',
      });
    });

    it('a proposal made without a text LLM carries no Auto cover pick', async () => {
      holder.llmConfigured = false;
      await proposeOk();
      expect((await getPendingProposal(db(), holder.ownerUserId!))!.autoCoverStyle).toBeNull();
    });

    it('starts with No limit when the request asks for none', async () => {
      const proposal = await proposeOk();
      expect(proposal.edit.durationMinutes).not.toBeNull();
      const { session } = await startOk(proposal.id, { targetDurationMinutes: null });
      expect(session).toMatchObject({ targetDurationMinutes: null, sessionMode: 'keep_going' });
    });

    it('starts on Keep Going with the Default Session duration when the request names no length', async () => {
      const first = await startOk((await proposeOk()).id);
      expect(first.session).toMatchObject({ targetDurationMinutes: 30, sessionMode: 'keep_going' });

      await updateGenerationSettings(db(), {
        ownerUserId: holder.ownerUserId!,
        patch: { defaultSessionDurationMinutes: 5 },
      });
      holder.llmConfigured = false;
      const second = await startOk((await proposeOk()).id);
      expect(second.session).toMatchObject({ targetDurationMinutes: 5, sessionMode: 'keep_going' });
    });

    it('replaces the active Session like any other start', async () => {
      const first = await startOk((await proposeOk()).id);
      const second = await startOk((await proposeOk()).id);
      expect(second.supersededSessionId).toBe(first.session.id);
    });

    it('a retried or concurrent Start returns the same Session and buys once', async () => {
      const proposal = await proposeOk();
      const [a, b] = await Promise.all([startOk(proposal.id), startOk(proposal.id)]);
      // A retry succeeds even once the budget is gone: nothing new is bought.
      await blockHeadroom();
      const retry = await startOk(proposal.id);

      expect(new Set([a.session.id, b.session.id, retry.session.id]).size).toBe(1);
      expect((await purchases()).sessions).toBe(1);
    });

    it('budget exhaustion after the preview blocks Start and keeps the proposal', async () => {
      const proposal = await proposeOk();
      await blockHeadroom();

      expect(await start(proposal.id)).toMatchObject({
        ok: false,
        error: { code: 'session_headroom_blocked' },
      });
      expect((await purchases()).sessions).toBe(0);
      expect((await pending())?.id).toBe(proposal.id);
    });

    it('refuses a replaced, dismissed, reset-invalidated or foreign proposal', async () => {
      const replaced = await proposeOk();
      const dismissed = await proposeOk({ replaces: replaced.id });
      await call('DELETE', { proposalId: dismissed.id });
      const reset = await proposeOk();
      await resetLearnedTaste(db(), { ownerUserId: holder.ownerUserId! });
      const foreign = await proposeOk();

      for (const id of [replaced.id, dismissed.id, reset.id]) {
        expect(await start(id)).toMatchObject({ ok: false, error: { code: 'conflict' } });
      }
      holder.ownerUserId = await createUser(testDb.db);
      expect(await start(foreign.id)).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect((await purchases()).sessions).toBe(0);
    });

    it('hands Edit the request text and picks the proposal was made from', async () => {
      await teachVocalTaste(holder.ownerUserId!);
      const proposal = await proposeOk();
      const stored = (await getPendingProposal(db(), holder.ownerUserId!))!;

      expect(proposal.edit).toEqual({
        prompt: stored.intent,
        genres: ['indie'],
        energy: 'medium',
        vocal: 'vocal',
        language: 'German',
        durationMinutes: expect.any(Number),
      });
    });
  });
});
