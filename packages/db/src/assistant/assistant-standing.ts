// Where a user stands with the Assistant: whether they have it, and how much of
// today's message allowance is left. The Admin has no daily allowance; a Member
// has the instance default unless the Admin gave them values of their own. The
// caller names the role, so a request decides the allowance and everything
// else that depends on the role from one reading of it.
//
// A day is the calendar date in the Instance timezone (`usageLimits
// .resetTimezone`), the same midnight every other budget resets on.

import { and, eq, lt, sql } from 'drizzle-orm';
import {
  effectiveAssistantAccess,
  limitDay,
  type AssistantAccess,
  type AssistantStanding,
  type LimitDay,
} from '@liedmotif/shared';
import type { Database } from '../client';
import type { UserRole } from '../profile/resolve-user-profile';
import { assistantUsage } from '../schema';
import { getMemberAssistantAccess } from '../settings/user-settings-repo';
import { getAssistantAccess, getUsageLimits } from '../setup/settings';

/** The Admin's standing. */
const NO_DAILY_ALLOWANCE: AssistantStanding = { enabled: true, allowance: null };

/** What a Member's messages are held to right now. */
interface MemberAllowance {
  access: AssistantAccess;
  day: LimitDay;
}

async function memberAllowance(db: Database, userId: string, now: Date): Promise<MemberAllowance> {
  const [instanceDefault, own, limits] = await Promise.all([
    getAssistantAccess(db),
    getMemberAssistantAccess(db, userId),
    getUsageLimits(db),
  ]);
  return {
    access: effectiveAssistantAccess(instanceDefault, own),
    day: limitDay(now, limits.resetTimezone),
  };
}

function memberStanding({ access, day }: MemberAllowance, used: number): AssistantStanding {
  return {
    enabled: access.enabled,
    allowance: {
      dailyMessages: access.dailyMessages,
      remaining: Math.max(0, access.dailyMessages - used),
      resetsAt: day.endsAt.toISOString(),
    },
  };
}

async function messagesCounted(db: Database, userId: string, date: string): Promise<number> {
  const [row] = await db
    .select({ messages: assistantUsage.messages })
    .from(assistantUsage)
    .where(and(eq(assistantUsage.userId, userId), eq(assistantUsage.day, date)))
    .limit(1);
  return row?.messages ?? 0;
}

/** Whose standing, and as of when. */
interface StandingQuery {
  userId: string;
  role: UserRole;
  now: Date;
}

/**
 * The user's standing as of `now`. Read-only: it answers whether a message
 * would be accepted and what the panel shows, and counts nothing.
 */
export async function resolveAssistantStanding(
  db: Database,
  args: StandingQuery,
): Promise<AssistantStanding> {
  if (args.role === 'admin') return NO_DAILY_ALLOWANCE;
  const allowance = await memberAllowance(db, args.userId, args.now);
  return memberStanding(allowance, await messagesCounted(db, args.userId, allowance.day.date));
}

/**
 * Take one message against the user's allowance for today, and report the
 * standing after it. `accepted: false` means the message must be refused: the
 * access is off, or the allowance is spent.
 *
 * The check and the increment are ONE statement: the row is created at one, or
 * raised by one only while it is below the allowance. Parallel messages queue
 * on the row, and each sees the count the one before it left, so they can never
 * add up to more than the allowance.
 *
 * The Admin has no daily allowance: their message is accepted and not counted.
 */
export async function countAssistantMessage(
  db: Database,
  args: StandingQuery,
): Promise<{ accepted: boolean; standing: AssistantStanding }> {
  if (args.role === 'admin') return { accepted: true, standing: NO_DAILY_ALLOWANCE };
  const allowance = await memberAllowance(db, args.userId, args.now);
  const { access, day } = allowance;
  if (!access.enabled) {
    const used = await messagesCounted(db, args.userId, day.date);
    return { accepted: false, standing: memberStanding(allowance, used) };
  }
  const [row] = await db
    .insert(assistantUsage)
    .values({ userId: args.userId, day: day.date, messages: 1 })
    .onConflictDoUpdate({
      target: [assistantUsage.userId, assistantUsage.day],
      set: { messages: sql`${assistantUsage.messages} + 1` },
      setWhere: lt(assistantUsage.messages, access.dailyMessages),
    })
    .returning({ messages: assistantUsage.messages });
  return {
    accepted: row !== undefined,
    standing: memberStanding(allowance, row?.messages ?? access.dailyMessages),
  };
}
