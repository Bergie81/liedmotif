import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_ACCESS,
  assistantAccessSchema,
  effectiveAssistantAccess,
  updateAssistantAccessRequestSchema,
  updateMemberAssistantAccessRequestSchema,
} from './assistant-access';

describe('Assistant access', () => {
  it('ships switched on, with 30 messages a day', () => {
    expect(DEFAULT_ASSISTANT_ACCESS).toEqual({ enabled: true, dailyMessages: 30 });
    expect(assistantAccessSchema.safeParse(DEFAULT_ASSISTANT_ACCESS).success).toBe(true);
  });

  it.each([1, 30, 1000])('accepts %i messages a day', (dailyMessages) => {
    expect(updateAssistantAccessRequestSchema.safeParse({ dailyMessages }).success).toBe(true);
  });

  it.each([0, -1, 1001, 2.5, '30', null])('refuses %s messages a day', (dailyMessages) => {
    expect(updateAssistantAccessRequestSchema.safeParse({ dailyMessages }).success).toBe(false);
  });

  it('takes a change to one field of the default, and nothing it does not know', () => {
    expect(updateAssistantAccessRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateAssistantAccessRequestSchema.safeParse({}).success).toBe(true);
    expect(updateAssistantAccessRequestSchema.safeParse({ monthlyMessages: 5 }).success).toBe(
      false,
    );
  });

  it("takes null in a change to a Member's values, to clear the field", () => {
    const cleared = { enabled: null, dailyMessages: null };
    expect(updateMemberAssistantAccessRequestSchema.safeParse(cleared).success).toBe(true);
    expect(updateMemberAssistantAccessRequestSchema.safeParse({ dailyMessages: 0 }).success).toBe(
      false,
    );
  });

  it('fills each field a Member does not hold from the instance default', () => {
    const instanceDefault = { enabled: true, dailyMessages: 30 };
    expect(effectiveAssistantAccess(instanceDefault, {})).toEqual(instanceDefault);
    expect(effectiveAssistantAccess(instanceDefault, { dailyMessages: 5 })).toEqual({
      enabled: true,
      dailyMessages: 5,
    });
    expect(effectiveAssistantAccess(instanceDefault, { enabled: false })).toEqual({
      enabled: false,
      dailyMessages: 30,
    });
  });
});
