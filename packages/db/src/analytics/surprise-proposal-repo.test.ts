import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { user } from '../schema';
import { createUser, GENERATION_FIXTURE_TABLES } from '../generation/test-fixtures';
import { clearListeningHistory } from './history-repo';
import { resetLearnedTaste, setPersonalizeSuggestions } from './taste-repo';
import {
  dismissPendingProposal,
  getPendingProposal,
  getProposalContext,
  savePendingProposal,
  startProposalSession,
  type SurpriseProposalDraft,
} from './surprise-proposal-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'surprise_proposals',
  'taste_evidence',
  'listening_occurrences',
  'listening_preferences',
  'user_settings',
  ...GENERATION_FIXTURE_TABLES,
];

function draft(title: string): SurpriseProposalDraft {
  return {
    adventurous: false,
    skipProfile: false,
    llmGenerated: true,
    intent: `A fresh ${title} session`,
    picks: { genres: ['ambient'], vocal: 'instrumental' },
    snapshot: { stylePrompt: `${title} style`, genreTags: ['ambient'] },
    title,
    coverConcept: null,
    preview: {
      title,
      mood: 'calm',
      genres: ['ambient'],
      energy: 'low',
      vocalMode: 'instrumental',
      voiceGender: null,
      language: null,
    },
  };
}

describeIfDb('pending Surprise Me proposal', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-surprise-proposal-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, TABLES);
  });

  async function saveFirst(ownerUserId: string, title = 'Tide') {
    const context = await getProposalContext(ctx.db, ownerUserId);
    const saved = await savePendingProposal(ctx.db, {
      ownerUserId,
      epoch: context.epoch,
      replaces: null,
      draft: draft(title),
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.reason}`);
    return saved.proposal;
  }

  it('keeps one proposal per owner, readable only by that owner', async () => {
    const owner = await createUser(ctx.db);
    const other = await createUser(ctx.db);
    const saved = await saveFirst(owner);

    expect((await getPendingProposal(ctx.db, owner))?.id).toBe(saved.id);
    expect(await getPendingProposal(ctx.db, other)).toBeNull();
    expect(await dismissPendingProposal(ctx.db, { ownerUserId: other, proposalId: saved.id })).toBe(
      false,
    );
    expect((await getPendingProposal(ctx.db, owner))?.title).toBe('Tide');
  });

  it('replaces only the proposal the caller saw', async () => {
    const owner = await createUser(ctx.db);
    const first = await saveFirst(owner);
    const { epoch } = await getProposalContext(ctx.db, owner);

    const replaced = await savePendingProposal(ctx.db, {
      ownerUserId: owner,
      epoch,
      replaces: first.id,
      draft: draft('Ember'),
    });
    expect(replaced.ok).toBe(true);

    // A stale tab still holds the first identity.
    const stale = await savePendingProposal(ctx.db, {
      ownerUserId: owner,
      epoch,
      replaces: first.id,
      draft: draft('Stale'),
    });
    expect(stale).toMatchObject({ ok: false, reason: 'superseded' });
    expect((await getPendingProposal(ctx.db, owner))?.title).toBe('Ember');
    expect(await dismissPendingProposal(ctx.db, { ownerUserId: owner, proposalId: first.id })).toBe(
      false,
    );
  });

  it('dismisses the current proposal', async () => {
    const owner = await createUser(ctx.db);
    const saved = await saveFirst(owner);
    expect(await dismissPendingProposal(ctx.db, { ownerUserId: owner, proposalId: saved.id })).toBe(
      true,
    );
    expect(await getPendingProposal(ctx.db, owner)).toBeNull();
  });

  it.each([
    ['Reset learned taste', (owner: string) => resetLearnedTaste(ctx.db, { ownerUserId: owner })],
    [
      'Clear listening history',
      (owner: string) => clearListeningHistory(ctx.db, { ownerUserId: owner }),
    ],
    [
      'turning Personalize suggestions off',
      (owner: string) => setPersonalizeSuggestions(ctx.db, { ownerUserId: owner, enabled: false }),
    ],
  ])('%s discards the proposal and refuses a late result', async (_name, invalidate) => {
    const owner = await createUser(ctx.db);
    await saveFirst(owner);
    const before = await getProposalContext(ctx.db, owner);

    await invalidate(owner);
    expect(await getPendingProposal(ctx.db, owner)).toBeNull();

    // A proposal requested before the change lands after it.
    const late = await savePendingProposal(ctx.db, {
      ownerUserId: owner,
      epoch: before.epoch,
      replaces: null,
      draft: draft('Late'),
    });
    expect(late).toMatchObject({ ok: false, reason: 'context_changed' });
    expect(await getPendingProposal(ctx.db, owner)).toBeNull();
  });

  it('keeps the proposal when Personalize suggestions is sent its current value again', async () => {
    const owner = await createUser(ctx.db);
    await saveFirst(owner);
    await setPersonalizeSuggestions(ctx.db, { ownerUserId: owner, enabled: true });
    expect((await getPendingProposal(ctx.db, owner))?.title).toBe('Tide');
  });

  describe('starting', () => {
    const start = (ownerUserId: string, proposalId: string) =>
      startProposalSession(ctx.db, {
        ownerUserId,
        proposalId,
        session: { sessionMode: 'keep_going' },
      });
    const sessionCount = async () =>
      Number((await ctx.pool.query('select count(*) from activity_sessions')).rows[0].count);

    it('starts the stored style as a Session and stops offering the proposal', async () => {
      const owner = await createUser(ctx.db);
      const saved = await saveFirst(owner);

      const started = await start(owner, saved.id);
      if (!started.ok) throw new Error('start refused');
      expect(started.alreadyStarted).toBe(false);
      expect(started.session.sessionStyleSnapshot).toEqual(saved.snapshot);
      expect(started.session.title).toBe('Tide');
      expect(started.session.userPrompt).toBe(saved.intent);

      expect(await getPendingProposal(ctx.db, owner)).toBeNull();
      expect((await getProposalContext(ctx.db, owner)).pendingId).toBeNull();
      expect(
        await dismissPendingProposal(ctx.db, { ownerUserId: owner, proposalId: saved.id }),
      ).toBe(false);
    });

    it('a retried or concurrent start returns the one Session', async () => {
      const owner = await createUser(ctx.db);
      const saved = await saveFirst(owner);

      const results = await Promise.all([start(owner, saved.id), start(owner, saved.id)]);
      const retry = await start(owner, saved.id);
      const ids = [...results, retry].map((result) => (result.ok ? result.session.id : null));
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toBeTruthy();
      expect(retry).toMatchObject({ ok: true, alreadyStarted: true });
      expect(await sessionCount()).toBe(1);
    });

    it('a stale start never hands back its Session once it is stopped or being deleted', async () => {
      for (const deleteRequested of [false, true]) {
        const owner = await createUser(ctx.db);
        const saved = await saveFirst(owner);
        const started = await start(owner, saved.id);
        if (!started.ok) throw new Error('start refused');
        await ctx.pool.query(
          `update activity_sessions set status = 'stopped', stopped_at = now(),
             delete_requested_at = case when $2 then now() end where id = $1`,
          [started.session.id, deleteRequested],
        );

        expect(await start(owner, saved.id)).toEqual({ ok: false, reason: 'not_pending' });
      }
      expect(await sessionCount()).toBe(2);
    });

    it('refuses a replaced, dismissed, reset or foreign proposal identity', async () => {
      const owner = await createUser(ctx.db);
      const other = await createUser(ctx.db);
      const first = await saveFirst(owner);
      expect(await start(other, first.id)).toEqual({ ok: false, reason: 'not_pending' });

      const { epoch } = await getProposalContext(ctx.db, owner);
      const second = await savePendingProposal(ctx.db, {
        ownerUserId: owner,
        epoch,
        replaces: first.id,
        draft: draft('Ember'),
      });
      if (!second.ok) throw new Error('replace refused');
      expect(await start(owner, first.id)).toEqual({ ok: false, reason: 'not_pending' });

      await resetLearnedTaste(ctx.db, { ownerUserId: owner });
      expect(await start(owner, second.proposal.id)).toEqual({ ok: false, reason: 'not_pending' });
      expect(await sessionCount()).toBe(0);
    });

    it('a started proposal does not block the next one', async () => {
      const owner = await createUser(ctx.db);
      const saved = await saveFirst(owner);
      await start(owner, saved.id);

      const next = await saveFirst(owner, 'Ember');
      expect((await getPendingProposal(ctx.db, owner))?.id).toBe(next.id);
    });
  });

  it('is removed with the account', async () => {
    const owner = await createUser(ctx.db);
    await saveFirst(owner);
    await ctx.db.delete(user).where(eq(user.id, owner));
    const rows = await ctx.pool.query('select 1 from surprise_proposals');
    expect(rows.rowCount).toBe(0);
  });
});
