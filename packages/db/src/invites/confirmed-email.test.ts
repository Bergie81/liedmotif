// Confirmed email: a confirm link proves its holder reads the address it was
// mailed to, so it may only ever confirm that address. Against real Postgres,
// because the address match and the one-shot consume are SQL predicates.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { user } from '../schema';
import { confirmEmailWithToken, createEmailConfirmLink } from './index';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const INVALID = { ok: false, reason: 'invalid_token' };

describeIfDb('confirmed email — the email_confirm link', () => {
  let ctx: TestDb;
  const userId = 'admin-1';

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-confirmed-email-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['invites', 'user']);
    await ctx.db.insert(user).values({ id: userId, name: 'John', email: 'john@example.test' });
  });

  async function isConfirmed(): Promise<boolean | undefined> {
    const [row] = await ctx.db
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId));
    return row?.emailVerified;
  }

  it('confirms the address it was minted for, exactly once', async () => {
    const { token } = await createEmailConfirmLink(ctx.db, {
      targetUserId: userId,
      email: 'john@example.test',
    });

    expect(await confirmEmailWithToken(ctx.db, { token })).toEqual({ ok: true, userId });
    expect(await isConfirmed()).toBe(true);
    expect(await confirmEmailWithToken(ctx.db, { token })).toEqual(INVALID);
  });

  it('refuses a link once the account has moved to another address', async () => {
    const { token } = await createEmailConfirmLink(ctx.db, {
      targetUserId: userId,
      email: 'john@example.test',
    });
    await ctx.db.update(user).set({ email: 'elsewhere@example.test' }).where(eq(user.id, userId));

    expect(await confirmEmailWithToken(ctx.db, { token })).toEqual(INVALID);
    expect(await isConfirmed()).toBe(false);
  });

  it('a second mint voids the first', async () => {
    const first = await createEmailConfirmLink(ctx.db, {
      targetUserId: userId,
      email: 'john@example.test',
    });
    const second = await createEmailConfirmLink(ctx.db, {
      targetUserId: userId,
      email: 'john@example.test',
    });

    expect(await confirmEmailWithToken(ctx.db, { token: first.token })).toEqual(INVALID);
    expect(await isConfirmed()).toBe(false);
    expect(await confirmEmailWithToken(ctx.db, { token: second.token })).toEqual({
      ok: true,
      userId,
    });
  });

  it('refuses a link past its 24 hours, and an unknown token', async () => {
    const minted = new Date('2026-10-01T10:00:00.000Z');
    const { token } = await createEmailConfirmLink(ctx.db, {
      targetUserId: userId,
      email: 'john@example.test',
      now: minted,
    });
    const dayLater = new Date(minted.getTime() + 24 * 60 * 60 * 1_000);

    expect(await confirmEmailWithToken(ctx.db, { token, now: dayLater })).toEqual(INVALID);
    expect(await confirmEmailWithToken(ctx.db, { token: 'not-a-real-token' })).toEqual(INVALID);
    expect(await isConfirmed()).toBe(false);
  });
});
