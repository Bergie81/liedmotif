import { describe, expect, it } from 'vitest';
import { memberAssistantView, parseDailyMessages } from './assistant-access-model';

const INSTANCE_DEFAULT = { enabled: true, dailyMessages: 30 };

describe("a Member's Assistant access on Settings → Members", () => {
  it('follows the default while the Admin has set nothing for the Member', () => {
    expect(memberAssistantView(INSTANCE_DEFAULT, {})).toEqual({
      enabled: { value: true, source: 'default' },
      dailyMessages: { value: 30, source: 'default' },
      overridden: false,
    });
  });

  it('moves with the default', () => {
    const view = memberAssistantView({ enabled: false, dailyMessages: 12 }, {});
    expect(view.enabled).toEqual({ value: false, source: 'default' });
    expect(view.dailyMessages).toEqual({ value: 12, source: 'default' });
  });

  it("marks only the field the Admin set as the Member's own", () => {
    expect(memberAssistantView(INSTANCE_DEFAULT, { enabled: false })).toEqual({
      enabled: { value: false, source: 'own' },
      dailyMessages: { value: 30, source: 'default' },
      overridden: true,
    });
    expect(memberAssistantView(INSTANCE_DEFAULT, { dailyMessages: 5 })).toEqual({
      enabled: { value: true, source: 'default' },
      dailyMessages: { value: 5, source: 'own' },
      overridden: true,
    });
  });

  it("keeps a Member's own value marked even when it equals the default", () => {
    const view = memberAssistantView(INSTANCE_DEFAULT, { enabled: true, dailyMessages: 30 });
    expect(view.enabled.source).toBe('own');
    expect(view.dailyMessages.source).toBe('own');
    expect(view.overridden).toBe(true);
  });
});

describe('a typed daily allowance', () => {
  it.each([
    ['1', 1],
    ['30', 30],
    [' 1000 ', 1000],
  ])('takes %j', (raw, value) => {
    expect(parseDailyMessages(raw)).toEqual({ value });
  });

  it.each(['', '0', '1001', '2.5', '-3', 'ten', '1e2'])('refuses %j, naming the range', (raw) => {
    expect(parseDailyMessages(raw)).toEqual({ error: 'Enter a whole number from 1 to 1000.' });
  });
});
