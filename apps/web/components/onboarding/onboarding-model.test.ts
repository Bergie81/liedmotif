import { describe, expect, it } from 'vitest';
import { EMPTY_LISTENER_PROFILE as EMPTY_PROFILE } from '@liedmotif/db';
import type { OnboardingData } from '@/lib/onboarding-data';
import type { OnboardingDraft } from './onboarding-model';
import {
  MEMBER_ONBOARDING_STEPS,
  ONBOARDING_STEPS,
  coverBudgetNote,
  memberOnboardingRecord,
  preselectedCoverProvider,
  textAiCostLine,
  onboardingProgress,
  onboardingRecord,
  resolveInitialTimezone,
  trackCeilingNote,
} from './onboarding-model';

const WINDOW = { used: 0, limit: 10, remaining: 10 };
const ROLLING = { tracksDay: WINDOW, tracksMonth: WINDOW, coversDay: WINDOW, coversMonth: WINDOW };

describe('onboarding step table', () => {
  it('runs the draft order: introduction, connect, finish', () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      'you',
      'people',
      'music',
      'tracks',
      'llm',
      'covers',
      'done',
    ]);
    expect(ONBOARDING_STEPS.map((step) => step.group)).toEqual([
      'Introduction',
      'Introduction',
      'Connect',
      'Connect',
      'Connect',
      'Connect',
      'Finish',
    ]);
  });

  it('marks every step optional except the profile and the music model', () => {
    expect(ONBOARDING_STEPS.filter((step) => step.optional).map((step) => step.id)).toEqual([
      'people',
      'tracks',
      'llm',
      'covers',
    ]);
  });
});

describe('member onboarding step table', () => {
  it('is exactly profile → people → the budget close', () => {
    expect(MEMBER_ONBOARDING_STEPS.map((step) => step.id)).toEqual(['you', 'people', 'done']);
  });

  it('contains no credential, ceiling, or instance step to reach — by construction', () => {
    const adminOnly = ['music', 'tracks', 'llm', 'covers'];
    const memberIds = MEMBER_ONBOARDING_STEPS.map((step) => step.id);
    for (const id of adminOnly) expect(memberIds).not.toContain(id);
  });

  it('paces the mobile strip over three steps, not seven', () => {
    expect(onboardingProgress(2, MEMBER_ONBOARDING_STEPS)).toEqual({
      group: 'Finish',
      position: 3,
      total: 3,
      percent: 100,
    });
  });

  it('records the personal rows plus the arriving Track budget', () => {
    const rows = memberOnboardingRecord(
      { profile: { ...EMPTY_PROFILE, name: 'Lisa' }, people: [] },
      {
        kind: 'rolling',
        figures: { ...ROLLING, tracksDay: { used: 0, limit: 20, remaining: 20 } },
      },
    );
    expect(rows.map((row) => row.label)).toEqual([
      'You',
      'MP3 artist',
      'Location',
      'People',
      'Tracks / day',
    ]);
    expect(rows.at(-1)).toEqual({ label: 'Tracks / day', value: '20 Tracks', muted: false });
  });

  it('records a One-time budget as a total, not a daily allowance', () => {
    const rows = memberOnboardingRecord(
      { profile: { ...EMPTY_PROFILE, name: 'Lisa' }, people: [] },
      {
        kind: 'oneTime',
        tracks: { used: 0, limit: 26, remaining: 26 },
        covers: { used: 0, limit: 60, remaining: 60 },
      },
    );
    expect(rows.at(-1)).toEqual({ label: 'Tracks', value: '26 Tracks in total', muted: false });
  });
});

describe('onboardingProgress', () => {
  it('numbers steps from one and fills the bar across the whole flow', () => {
    const first = onboardingProgress(0);
    expect(first).toMatchObject({ group: 'Introduction', position: 1, total: 7 });
    expect(first.percent).toBeCloseTo(14.29, 2);
    expect(onboardingProgress(6)).toEqual({
      group: 'Finish',
      position: 7,
      total: 7,
      percent: 100,
    });
  });

  it('clamps a position outside the table instead of reading past it', () => {
    expect(onboardingProgress(-3).position).toBe(1);
    expect(onboardingProgress(99).position).toBe(7);
  });
});

describe('trackCeilingNote', () => {
  it('translates a daily Track ceiling into listening time', () => {
    // 40 Tracks x 3.5 min = 140 min.
    expect(trackCeilingNote(40)).toEqual({ tracks: 40, hours: 2, minutes: 20 });
  });

  it('reads a sub-hour ceiling without a leading zero hour', () => {
    expect(trackCeilingNote(10)).toEqual({ tracks: 10, hours: 0, minutes: 35 });
  });

  it('treats a zero ceiling as no fresh music at all', () => {
    expect(trackCeilingNote(0)).toEqual({ tracks: 0, hours: 0, minutes: 0 });
  });
});

describe('coverBudgetNote', () => {
  it("prices a daily Cover ceiling at the selected provider's price per Cover", () => {
    expect(coverBudgetNote(20, 'openrouter')).toEqual({ covers: 20, dailyCostUsd: '1.40' });
    expect(coverBudgetNote(20, 'openai')).toEqual({ covers: 20, dailyCostUsd: '1.20' });
    expect(coverBudgetNote(20, 'gemini')).toEqual({ covers: 20, dailyCostUsd: '0.80' });
  });

  it('reports no spend when generated Covers are switched off', () => {
    expect(coverBudgetNote(0, 'openai')).toEqual({ covers: 0, dailyCostUsd: '0.00' });
  });
});

describe('textAiCostLine', () => {
  it('says what each Text AI option costs and whether its key can paint Covers', () => {
    expect(textAiCostLine('openai')).toBe(
      'Under 1 cent per Session. This key can also paint your Covers, about 6 cents each.',
    );
    expect(textAiCostLine('gemini')).toBe(
      'Free to start. This key can also paint your Covers, about 4 cents each. Covers need billing turned on at Google.',
    );
    expect(textAiCostLine('ollama')).toBe('Free, runs on your machine. It cannot paint Covers.');
    expect(textAiCostLine('openrouter')).toBe(
      'Cost depends on the model. This key can also paint your Covers, about 7 cents each.',
    );
    expect(textAiCostLine('openai-compatible')).toBe(
      'Cost depends on your service. It cannot paint Covers.',
    );
  });

  it('says nothing for a provider it has no line for', () => {
    expect(textAiCostLine('something-else')).toBeNull();
  });
});

describe('preselectedCoverProvider', () => {
  it('keeps a Cover provider already stored or set in .env', () => {
    expect(
      preselectedCoverProvider({ chosenProviderKey: 'openrouter', sharedKeyVendor: 'gemini' }),
    ).toBe('openrouter');
  });

  it("starts on the Text AI's vendor when its key can paint", () => {
    expect(preselectedCoverProvider({ chosenProviderKey: null, sharedKeyVendor: 'gemini' })).toBe(
      'gemini',
    );
  });

  it('starts on OpenAI otherwise', () => {
    expect(preselectedCoverProvider({ chosenProviderKey: null, sharedKeyVendor: null })).toBe(
      'openai',
    );
  });
});

describe('onboardingRecord', () => {
  const data = {
    profile: EMPTY_PROFILE,
    people: { initialPeople: [] },
    limits: { dailyGenerationTasks: 20, maxConcurrentJobs: 1, monthlyGenerationTasks: 200 },
    tracksPerRequest: 2,
    music: { environmentManaged: false },
    llm: { environmentManaged: false },
    image: { environmentManaged: false },
    musicProviderCoverConfigured: false,
  } as unknown as OnboardingData;
  const empty: OnboardingDraft = {
    profile: EMPTY_PROFILE,
    timezone: 'Europe/Berlin',
    people: [],
    musicConnected: false,
    llmConnected: false,
    llmModel: '',
    imageConnected: false,
    imageModel: '',
    imageProviderKey: null,
    imageOwnKey: false,
    sharedKeyVendor: null,
    ceiling: { enabled: true, dailyTracks: '40', monthlyTracks: '400', concurrentTracks: '2' },
    coverBudget: {
      tailoredCoverArtEnabled: false,
      ceilingEnabled: true,
      coversPerDay: '20',
      coversPerMonth: '300',
    },
    savedCeiling: { enabled: true, dailyTracks: '40', monthlyTracks: '400', concurrentTracks: '2' },
    savedCoverBudget: {
      tailoredCoverArtEnabled: false,
      ceilingEnabled: true,
      coversPerDay: '20',
      coversPerMonth: '300',
    },
  };
  const rowFor = (draft: OnboardingDraft, label: string, over: Partial<OnboardingData> = {}) =>
    onboardingRecord(draft, { ...data, ...over }).find((row) => row.label === label);

  it('shows every unset row as unset', () => {
    expect(
      onboardingRecord(empty, data)
        .filter((row) => row.muted)
        .map((row) => row.label),
    ).toEqual([
      'You',
      'MP3 artist',
      'Location',
      'People',
      'Music model',
      'Text AI',
      'Cover images',
    ]);
  });

  it('records a switched-off Track ceiling as no limit, like a Text AI left off', () => {
    const draft = { ...empty, savedCeiling: { ...empty.savedCeiling, enabled: false } };
    expect(rowFor(draft, 'Tracks / day')).toEqual({
      label: 'Tracks / day',
      value: 'No limit',
      muted: true,
    });
  });

  it('reports a spend cap only once it is saved, never an edit still on its step', () => {
    const editing = {
      ...empty,
      ceiling: { ...empty.ceiling, dailyTracks: '10' },
      savedCeiling: { ...empty.savedCeiling, enabled: false },
      coverBudget: { ...empty.coverBudget, tailoredCoverArtEnabled: true },
    };
    expect(rowFor(editing, 'Tracks / day')?.value).toBe('No limit');
    expect(rowFor({ ...editing, imageConnected: true }, 'Cover images')?.value).toBe(
      'Liedmotif Cover',
    );
  });

  it('falls back to the name for the MP3 artist, because exports do the same', () => {
    const draft = { ...empty, profile: { ...EMPTY_PROFILE, name: 'John' } };
    expect(rowFor(draft, 'MP3 artist')).toEqual({
      label: 'MP3 artist',
      value: 'John',
      muted: false,
    });
  });

  it('reports an environment-provided key as such rather than as connected', () => {
    expect(
      rowFor({ ...empty, musicConnected: true }, 'Music model', {
        music: { environmentManaged: true },
      } as Partial<OnboardingData>),
    ).toEqual({ label: 'Music model', value: 'From env', muted: false });
  });

  it('names the LLM model once one is connected', () => {
    const draft = { ...empty, llmConnected: true, llmModel: 'minimax/minimax-m3' };
    expect(rowFor(draft, 'Text AI')?.value).toBe('minimax/minimax-m3');
  });

  it('joins a partial location instead of leaving a dangling comma', () => {
    const draft = { ...empty, profile: { ...EMPTY_PROFILE, city: 'Reykjavík' } };
    expect(rowFor(draft, 'Location')).toEqual({
      label: 'Location',
      value: 'Reykjavík',
      muted: false,
    });
  });

  it('counts named People in the singular when there is one', () => {
    const person = { id: 'p1', role: 'owner' as const, about: '', photos: [] };
    expect(rowFor({ ...empty, people: [{ ...person, name: 'John' }] }, 'People')?.value).toBe(
      '1 person',
    );
    expect(
      rowFor(
        {
          ...empty,
          people: [
            { ...person, name: 'John' },
            { ...person, id: 'p2', name: 'Jane' },
            { ...person, id: 'p3', name: 'Nele' },
          ],
        },
        'People',
      )?.value,
    ).toBe('3 people');
  });

  it('names the Cover source, and treats the placeholder fallback as nothing chosen', () => {
    const painting = {
      ...empty,
      savedCoverBudget: { ...empty.savedCoverBudget, tailoredCoverArtEnabled: true },
    };
    expect(rowFor(empty, 'Cover images')).toEqual({
      label: 'Cover images',
      value: 'Liedmotif Cover',
      muted: true,
    });
    // A key saved on the covers step paints from then on, as the rail records.
    expect(rowFor({ ...painting, imageConnected: true }, 'Cover images')).toEqual({
      label: 'Cover images',
      value: 'Tailored',
      muted: false,
    });
  });
});

describe('resolveInitialTimezone', () => {
  it('suggests the browser zone while the stored one is the shipped UTC default', () => {
    expect(resolveInitialTimezone('UTC', 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('leaves a zone somebody actually chose', () => {
    expect(resolveInitialTimezone('Asia/Tokyo', 'Europe/Berlin')).toBe('Asia/Tokyo');
  });
});
