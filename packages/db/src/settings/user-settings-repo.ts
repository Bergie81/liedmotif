// Owner-scoped `user_settings` reads/writes. The table is a typed key/value
// store (`app_settings`' per-user counterpart); `playback` and `generation` are
// its keys. Values are validated at the ROUTE boundary with the
// `@liedmotif/shared` Zod schemas — this repo only merges defaults on read and
// upserts full, already-validated objects on write.

import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_GENERATION_SETTINGS,
  DEFAULT_MEMBER_LIMITS,
  DEFAULT_ONBOARDING_STATE,
  DEFAULT_PLAYBACK_SETTINGS,
  type GenerationSettings,
  type MemberLimits,
  type OnboardingState,
  type PlaybackSettings,
} from '@liedmotif/shared';
import type { DbOrTx } from '../transactions';
import { userProfiles, userSettings, USER_SETTINGS_KEYS, type UserSettingKey } from '../schema';

/**
 * Read one owner-scoped value by key, or `null` when it has never been written
 * — `app_settings`' `readSetting` for the per-user store. Values that are not
 * settings (a derived per-owner cache) have no defaults to merge and use this
 * directly.
 */
export async function readUserSetting<T>(
  db: DbOrTx,
  ownerUserId: string,
  key: UserSettingKey,
): Promise<T | null> {
  const [row] = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.ownerUserId, ownerUserId), eq(userSettings.key, key)))
    .limit(1);
  return (row?.value as T | undefined) ?? null;
}

/** Upsert one owner-scoped value by key, replacing whatever is stored. */
export async function writeUserSetting(
  db: DbOrTx,
  ownerUserId: string,
  key: UserSettingKey,
  value: unknown,
): Promise<void> {
  await db
    .insert(userSettings)
    .values({ ownerUserId, key, value })
    .onConflictDoUpdate({
      target: [userSettings.ownerUserId, userSettings.key],
      set: { value, updatedAt: new Date() },
    });
}

/**
 * The owner's effective settings under one key: the stored object over the
 * shipped defaults. Spreading over defaults makes a later shape extension safe —
 * a row written before a new field existed still reads complete.
 */
async function getUserSetting<T extends object>(
  db: DbOrTx,
  ownerUserId: string,
  key: UserSettingKey,
  defaults: T,
): Promise<T> {
  const stored = await readUserSetting<Partial<T>>(db, ownerUserId, key);
  return { ...defaults, ...(stored ?? {}) };
}

/**
 * Apply a partial settings patch for the owner under one key and return the
 * full effective result. A single atomic upsert: the conflict branch merges
 * ONLY the patch keys over the stored jsonb (`value || patch`), so two
 * concurrent patches to different fields both survive — including when they
 * race on creating the very first row. The caller (route) has already
 * validated the patch against the shared schema.
 */
async function updateUserSetting<T extends object>(
  db: DbOrTx,
  ownerUserId: string,
  key: UserSettingKey,
  defaults: T,
  patch: Partial<T>,
): Promise<T> {
  const [row] = await db
    .insert(userSettings)
    .values({ ownerUserId, key, value: { ...defaults, ...patch } })
    .onConflictDoUpdate({
      target: [userSettings.ownerUserId, userSettings.key],
      set: {
        value: sql`${userSettings.value} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ value: userSettings.value });
  return { ...defaults, ...(row!.value as Partial<T>) };
}

/** The owner's effective playback settings (blend on/off + crossfade). */
export async function getPlaybackSettings(
  db: DbOrTx,
  ownerUserId: string,
): Promise<PlaybackSettings> {
  return getUserSetting(db, ownerUserId, USER_SETTINGS_KEYS.playback, DEFAULT_PLAYBACK_SETTINGS);
}

export async function updatePlaybackSettings(
  db: DbOrTx,
  args: { ownerUserId: string; patch: Partial<PlaybackSettings> },
): Promise<PlaybackSettings> {
  return updateUserSetting(
    db,
    args.ownerUserId,
    USER_SETTINGS_KEYS.playback,
    DEFAULT_PLAYBACK_SETTINGS,
    args.patch,
  );
}

/** The owner's effective Buffer enablement and ready-ahead target. */
export async function getGenerationSettings(
  db: DbOrTx,
  ownerUserId: string,
): Promise<GenerationSettings> {
  return getUserSetting(
    db,
    ownerUserId,
    USER_SETTINGS_KEYS.generation,
    DEFAULT_GENERATION_SETTINGS,
  );
}

export async function updateGenerationSettings(
  db: DbOrTx,
  args: { ownerUserId: string; patch: Partial<GenerationSettings> },
): Promise<GenerationSettings> {
  return updateUserSetting(
    db,
    args.ownerUserId,
    USER_SETTINGS_KEYS.generation,
    DEFAULT_GENERATION_SETTINGS,
    args.patch,
  );
}

/**
 * A Member's effective personal budget: the stored `limits` row over the
 * shipped defaults. A fresh Member with no row yet is capped by the defaults —
 * never uncapped. The value is counted in provider tasks; every read that
 * reaches a human converts to Tracks first.
 */
export async function getMemberLimits(db: DbOrTx, ownerUserId: string): Promise<MemberLimits> {
  return getUserSetting(db, ownerUserId, USER_SETTINGS_KEYS.limits, DEFAULT_MEMBER_LIMITS);
}

/**
 * Write a Member's budget. The caller is the ADMIN writing another user's
 * `user_settings` row (the Admin-only members routes / the invite claim
 * snapshot) — the table is owner-scoped by row, not by writer.
 */
export async function updateMemberLimits(
  db: DbOrTx,
  args: { ownerUserId: string; patch: Partial<MemberLimits> },
): Promise<MemberLimits> {
  return updateUserSetting(
    db,
    args.ownerUserId,
    USER_SETTINGS_KEYS.limits,
    DEFAULT_MEMBER_LIMITS,
    args.patch,
  );
}

/**
 * Every Member's effective budget (defaults merged), for the over-subscription
 * readout and the Members administration surface. Members only — the Admin's
 * caps live in `app_settings.usageLimits`, outside the Pool.
 */
export async function listMemberLimits(
  db: DbOrTx,
): Promise<Array<{ userId: string; limits: MemberLimits }>> {
  const rows = await db
    .select({ userId: userProfiles.userId, value: userSettings.value })
    .from(userProfiles)
    .leftJoin(
      userSettings,
      and(
        eq(userSettings.ownerUserId, userProfiles.userId),
        eq(userSettings.key, USER_SETTINGS_KEYS.limits),
      ),
    )
    .where(eq(userProfiles.role, 'member'))
    .orderBy(userProfiles.createdAt);
  return rows.map((row) => ({
    userId: row.userId,
    limits: { ...DEFAULT_MEMBER_LIMITS, ...((row.value ?? {}) as Partial<MemberLimits>) },
  }));
}

/** Whether — and when — the owner finished first-login onboarding. */
export async function getOnboardingState(
  db: DbOrTx,
  ownerUserId: string,
): Promise<OnboardingState> {
  return getUserSetting(db, ownerUserId, USER_SETTINGS_KEYS.onboarding, DEFAULT_ONBOARDING_STATE);
}

/** Stamp first-login onboarding as done, so the app guards stop diverting here. */
export async function completeOnboarding(
  db: DbOrTx,
  ownerUserId: string,
): Promise<OnboardingState> {
  return updateUserSetting(
    db,
    ownerUserId,
    USER_SETTINGS_KEYS.onboarding,
    DEFAULT_ONBOARDING_STATE,
    { completedAt: new Date().toISOString() },
  );
}
