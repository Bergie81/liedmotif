// Batched/concurrent twins of the cover-spend counting layer: the per-owner
// grouped count must agree with N single-scope calls, the concurrent usage read
// must agree with the sequential one, and the legacy-cover short-circuit must
// persist only once the pre-ledger set is truly empty.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionCoverPlanRecord } from '../schema';
import {
  APP_SETTINGS_KEYS,
  coverImages,
  sessionCoverGenerations,
  user,
  userProfiles,
} from '../schema';
import { readSetting, writeSetting } from '../setup/settings';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { ownerScope } from '../member-pool';
import { countLegacyGeneratedCoversInWindow } from './generated-repo';
import { countReservedOrPossiblyPaidCovers } from './generation-ledger-repo';
import { countCoverSpendByOwner, getCoverUsage, getCoverUsageConcurrently } from './usage';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const NOW = new Date('2026-06-29T12:00:00Z');
const SINCE = new Date('2026-06-29T00:00:00Z');

const FIXTURE_PLAN: SessionCoverPlanRecord = {
  sessionName: 'Batch fixture',
  coverConcept: null,
  selectedStyle: 'minimal',
  resolvedStyle: 'minimal',
  customDefinition: null,
  styleFallbackReason: null,
  concreteScene: 'one scene',
  semanticCueIds: [],
  conceptMode: 'title symbol',
  subjectFamily: 'one subject',
  composition: 'one composition',
  palette: 'one palette',
  material: 'one material',
  lighting: 'one light',
  referenceTreatment: null,
  prompt: 'private prompt',
  exclusions: [],
  altText: 'Batch fixture',
  candidateCount: 1,
};

describeIfDb('cover spend counting — batched + concurrent twins', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-cover-batched-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, [
      'session_cover_generations',
      'cover_images',
      'app_settings',
      'user',
    ]);
  });

  async function createOwner(): Promise<string> {
    const id = `user-${randomUUID()}`;
    await ctx.db.insert(user).values({ id, name: id, email: `${id}@example.test` });
    await ctx.db.insert(userProfiles).values({ userId: id, role: 'member' });
    return id;
  }

  async function spendLedgerCover(
    ownerUserId: string,
    createdAt = NOW,
    submitted?: { submittedAt: Date },
  ): Promise<void> {
    const id = randomUUID();
    await ctx.db.insert(sessionCoverGenerations).values({
      id,
      ownerUserId,
      activitySessionId: null,
      // A submitted attempt is settled and possibly paid; an unsubmitted one is
      // still a live reservation. Both count, on their own timestamp.
      ...(submitted
        ? {
            state: 'quality_rejected' as const,
            possiblyPaid: true,
            submittedAt: submitted.submittedAt,
          }
        : { state: 'reserved' as const }),
      plan: FIXTURE_PLAN,
      planVersion: 'test-plan',
      promptVersion: 'test-prompt',
      planHash: `plan-${id}`,
      promptHash: `prompt-${id}`,
      fingerprint: {},
      providerKey: 'test-provider',
      model: 'test-model',
      capabilitySnapshot: {},
      idempotencyKey: `cover-${id}`,
      retryPolicy: { version: 'test' },
      coverImageId: randomUUID(),
      storageKey: `covers/${id}.webp`,
      createdAt,
    });
  }

  async function seedLegacyCover(ownerUserId: string): Promise<void> {
    await ctx.db.insert(coverImages).values({
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: `legacy/${randomUUID()}.webp`,
      provenance: { ownerUserId },
      createdAt: NOW,
    });
  }

  it('countCoverSpendByOwner matches per-owner single-scope counts', async () => {
    const ownerA = await createOwner();
    const ownerB = await createOwner();
    const ownerIdle = await createOwner();
    await spendLedgerCover(ownerA);
    await spendLedgerCover(ownerA);
    await seedLegacyCover(ownerB);
    await spendLedgerCover(ownerB, new Date('2026-06-28T00:00:00Z')); // pre-window

    const byOwner = await countCoverSpendByOwner(ctx.db, { since: SINCE });
    for (const owner of [ownerA, ownerB, ownerIdle]) {
      const scope = ownerScope(owner);
      const expected =
        (await countReservedOrPossiblyPaidCovers(ctx.db, { scope, since: SINCE })) +
        (await countLegacyGeneratedCoversInWindow(ctx.db, { scope, since: SINCE }));
      expect(byOwner.get(owner) ?? 0).toBe(expected);
    }
  });

  it('windows a submitted attempt on its submit time, not its creation time', async () => {
    // Spend happens at submit, so an attempt created before the window but
    // submitted inside it is in-window money; one submitted before the window has
    // already been counted there. Counting `created_at` alone would let an
    // attempt reserved just before midnight escape the day it was paid for.
    const owner = await createOwner();
    const beforeWindow = new Date('2026-06-28T22:00:00Z');
    await spendLedgerCover(owner, beforeWindow, { submittedAt: NOW });
    await spendLedgerCover(owner, NOW, { submittedAt: beforeWindow });

    expect(
      await countReservedOrPossiblyPaidCovers(ctx.db, { scope: ownerScope(owner), since: SINCE }),
    ).toBe(1);
    expect((await countCoverSpendByOwner(ctx.db, { since: SINCE })).get(owner)).toBe(1);
  });

  it('getCoverUsageConcurrently matches the sequential read', async () => {
    const owner = await createOwner();
    await spendLedgerCover(owner);
    await seedLegacyCover(owner);
    const args = {
      scope: ownerScope(owner),
      caps: { generatedCoversPerDay: 5, generatedCoversPerMonth: 30 },
      resetTimezone: 'UTC',
      now: NOW,
    };
    expect(await getCoverUsageConcurrently(ctx.db, args)).toEqual(
      await getCoverUsage(ctx.db, args),
    );
  });

  it('honors the migration-persisted exhaustion verdict and stays a pure read', async () => {
    const owner = await createOwner();
    const scope = ownerScope(owner);
    await seedLegacyCover(owner);

    // No verdict stored (this suite truncates app_settings) → the count runs.
    expect(await countLegacyGeneratedCoversInWindow(ctx.db, { scope, since: SINCE })).toBe(1);
    expect(await readSetting(ctx.db, APP_SETTINGS_KEYS.legacyGeneratedCoversExhausted)).toBeNull();

    // `true` short-circuits to one key read; `false` keeps counting. The count
    // itself never writes the verdict — migration 0064 owns that, once.
    await writeSetting(ctx.db, APP_SETTINGS_KEYS.legacyGeneratedCoversExhausted, true);
    expect(await countLegacyGeneratedCoversInWindow(ctx.db, { scope, since: SINCE })).toBe(0);
    await writeSetting(ctx.db, APP_SETTINGS_KEYS.legacyGeneratedCoversExhausted, false);
    expect(await countLegacyGeneratedCoversInWindow(ctx.db, { scope, since: SINCE })).toBe(1);
  });
});
