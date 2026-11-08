// The pure shape of first-login onboarding: the step table, the draft the wizard
// carries, and the readouts the rail, the mobile strip, and the two spend screens
// render. No React and no fetching, so the numbers the owner is asked to trust are
// unit-testable.

import type { ListenerProfile } from '@liedmotif/db';
import { DEFAULT_UNIT_COSTS } from '@liedmotif/shared';
import { namedPeopleCount } from '@/components/settings/people-form-model';
import type { PersonEditorValue } from '@/components/settings/people-types';
import { coverSource, type CoverSource } from '@/lib/cover-source';
import type { BudgetUsage } from '@/lib/my-budget-model';
import type { OnboardingData } from '@/lib/onboarding-data';
import { detectTimezone } from '@/lib/timezones';
import {
  coverBudgetFromLimits,
  trackCeilingFromLimits,
  type CoverBudget,
  type TrackCeiling,
} from './onboarding-limits-model';

export type OnboardingStepId = 'you' | 'people' | 'music' | 'tracks' | 'llm' | 'covers' | 'done';

export type OnboardingGroup = 'Introduction' | 'Connect' | 'Finish';

export interface OnboardingStep {
  id: OnboardingStepId;
  /** The rail label — shorter than the screen's own headline. */
  title: string;
  /** Skippable: the rail says so, and the screen offers a way past. */
  optional?: boolean;
}

/**
 * One decision per screen, in three groups. The order is the flow: the two personal
 * screens introduce the owner before any provider asks for money, and each spend
 * ceiling immediately follows the credential that spends it.
 */
export const ONBOARDING_GROUPS: readonly { group: OnboardingGroup; steps: OnboardingStep[] }[] = [
  {
    group: 'Introduction',
    steps: [
      { id: 'you', title: 'You' },
      { id: 'people', title: 'People', optional: true },
    ],
  },
  {
    group: 'Connect',
    steps: [
      { id: 'music', title: 'Music model' },
      { id: 'tracks', title: 'Track limit', optional: true },
      { id: 'llm', title: 'Writing AI', optional: true },
      { id: 'covers', title: 'Cover art', optional: true },
    ],
  },
  { group: 'Finish', steps: [{ id: 'done', title: 'Done' }] },
];

export type OnboardingGroupTable = readonly { group: OnboardingGroup; steps: OnboardingStep[] }[];

/**
 * A Member's welcome is the two personal screens plus the budget close — no
 * credential, ceiling, or instance step exists in this table, so none is
 * reachable by URL or by step index, by construction.
 */
export const MEMBER_ONBOARDING_GROUPS: OnboardingGroupTable = [
  {
    group: 'Introduction',
    steps: [
      { id: 'you', title: 'You' },
      { id: 'people', title: 'People', optional: true },
    ],
  },
  { group: 'Finish', steps: [{ id: 'done', title: 'Your budget' }] },
];

function flattenSteps(
  groups: OnboardingGroupTable,
): readonly (OnboardingStep & { group: OnboardingGroup })[] {
  return groups.flatMap(({ group, steps }) => steps.map((step) => ({ ...step, group })));
}

/** Every step in flow order, each carrying the group it belongs to. */
export const ONBOARDING_STEPS: readonly (OnboardingStep & { group: OnboardingGroup })[] =
  flattenSteps(ONBOARDING_GROUPS);

export const MEMBER_ONBOARDING_STEPS: readonly (OnboardingStep & { group: OnboardingGroup })[] =
  flattenSteps(MEMBER_ONBOARDING_GROUPS);

interface OnboardingProgress {
  group: OnboardingGroup;
  position: number;
  total: number;
  percent: number;
}

/** Where the owner is, for the mobile strip and the rail's group highlight. */
export function onboardingProgress(
  index: number,
  steps: readonly (OnboardingStep & { group: OnboardingGroup })[] = ONBOARDING_STEPS,
): OnboardingProgress {
  const total = steps.length;
  const bounded = Math.min(Math.max(index, 0), total - 1);
  return {
    group: steps[bounded]!.group,
    position: bounded + 1,
    total,
    percent: ((bounded + 1) / total) * 100,
  };
}

/**
 * Which zone the profile step opens on. `UTC` is what ships, so nobody has chosen it
 * yet and the browser's own zone is the better suggestion. Any other stored zone was
 * chosen — in `.env` or here — and is left alone.
 *
 * `detected` is a parameter because reading it is a browser-only act: the caller runs
 * this after mount, never during a render the server also performs.
 */
export function resolveInitialTimezone(stored: string, detected = detectTimezone()): string {
  return stored === 'UTC' ? detected : stored;
}

/**
 * Everything the flow edits, in one object. Each step still persists its own
 * decision through its own route; this is only what the rail reads back and what a
 * revisited step re-renders from.
 */
export interface OnboardingDraft {
  profile: ListenerProfile;
  /** The instance's limit-reset zone, asked on the profile step. */
  timezone: string;
  people: PersonEditorValue[];
  /** A resolvable music credential — from `.env`, already stored, or just proven. */
  musicConnected: boolean;
  llmConnected: boolean;
  llmModel: string;
  /** A resolvable cover-image key — from `.env`, already stored, or saved on its step. */
  imageConnected: boolean;
  imageModel: string;
  ceiling: TrackCeiling;
  coverBudget: CoverBudget;
}

export function initialOnboardingDraft(data: OnboardingData): OnboardingDraft {
  return {
    profile: data.profile,
    timezone: data.limits.resetTimezone,
    people: data.people.initialPeople,
    musicConnected: data.music.configured,
    llmConnected: data.llm.configured,
    llmModel: data.llm.model ?? '',
    imageConnected: data.image.configured,
    imageModel: data.image.model ?? '',
    ceiling: trackCeilingFromLimits(data.limits, data.tracksPerRequest),
    coverBudget: coverBudgetFromLimits(data.limits),
  };
}

/**
 * A Track's typical playing time — Suno renders roughly three-and-a-half minutes.
 * It is what turns an abstract daily ceiling into an amount of listening, the only
 * form in which the number means anything.
 */
const MINUTES_PER_TRACK = 3.5;

/** About what one Track costs on the default music provider. */
export const TRACK_COST_CENTS = Math.round(DEFAULT_UNIT_COSTS.perTrackUsd * 100);

/** About what one generated Cover costs on the default image model. */
export const COVER_COST_CENTS = Math.round(DEFAULT_UNIT_COSTS.perCoverUsd * 100);

interface TrackCeilingNote {
  tracks: number;
  hours: number;
  minutes: number;
}

/** How much new music a daily Track ceiling buys, across every Session. */
export function trackCeilingNote(tracks: number): TrackCeilingNote {
  const total = Math.round(Math.max(tracks, 0) * MINUTES_PER_TRACK);
  return { tracks, hours: Math.floor(total / 60), minutes: total % 60 };
}

interface CoverBudgetNote {
  covers: number;
  /** The ceiling's worst-case daily spend, formatted to cents. */
  dailyCostUsd: string;
}

export function coverBudgetNote(covers: number): CoverBudgetNote {
  return {
    covers,
    dailyCostUsd: ((Math.max(covers, 0) * COVER_COST_CENTS) / 100).toFixed(2),
  };
}

const COVER_SOURCE_LABELS: Record<CoverSource, string> = {
  image: 'Tailored',
  'music-provider': 'Music provider',
  none: 'Liedmotif Cover',
};

export interface OnboardingRecordRow {
  label: string;
  value: string;
  /** Nothing has been set for this row yet, so it renders dimmed. */
  muted: boolean;
}

function row(label: string, value: string, set: boolean): OnboardingRecordRow {
  return { label, value, muted: !set };
}

/** How a resolved credential reports itself: env wins, and says so. */
function credentialRow(
  label: string,
  credential: { environmentManaged: boolean },
  connected: boolean,
  connectedLabel: string,
  absentLabel: string,
): OnboardingRecordRow {
  if (credential.environmentManaged) return row(label, 'From env', true);
  return row(label, connected ? connectedLabel : absentLabel, connected);
}

/** What a Member's welcome edits: the two personal screens, nothing instance-scoped. */
export interface MemberOnboardingDraft {
  profile: ListenerProfile;
  people: PersonEditorValue[];
}

/** The Member rail's "Set so far" list — personal rows plus the budget they arrive with. */
export function memberOnboardingRecord(
  draft: MemberOnboardingDraft,
  budget: BudgetUsage,
): OnboardingRecordRow[] {
  const { profile } = draft;
  const artist = profile.artistName || profile.name;
  const place = [profile.city, profile.country].filter(Boolean).join(', ');
  const named = namedPeopleCount(draft.people);
  return [
    row('You', profile.name || '—', Boolean(profile.name)),
    row('MP3 artist', artist || '—', Boolean(artist)),
    row('Location', place || 'Not set', Boolean(place)),
    row('People', named ? `${named} ${named === 1 ? 'person' : 'people'}` : 'None', named > 0),
    budget.kind === 'oneTime'
      ? row('Tracks', `${budget.tracks.limit} Tracks in total`, true)
      : row('Tracks / day', `${budget.figures.tracksDay.limit} Tracks`, true),
  ];
}

/**
 * The rail's "Set so far" list — the overview doubling as a record of what the owner
 * has committed. The draft carries what the flow edits; every other value is read
 * straight off the load.
 */
export function onboardingRecord(
  draft: OnboardingDraft,
  data: OnboardingData,
): OnboardingRecordRow[] {
  const { profile } = draft;
  // An empty Artist Name is not "unset" — exported MP3s fall back to the name.
  const artist = profile.artistName || profile.name;
  const place = [profile.city, profile.country].filter(Boolean).join(', ');
  const named = namedPeopleCount(draft.people);
  const covers = coverSource({
    imageProviderConfigured: draft.imageConnected,
    musicProviderCoverConfigured: data.musicProviderCoverConfigured,
    ...draft.coverBudget,
  });
  return [
    row('You', profile.name || '—', Boolean(profile.name)),
    row('MP3 artist', artist || '—', Boolean(artist)),
    row('Location', place || 'Not set', Boolean(place)),
    row('People', named ? `${named} ${named === 1 ? 'person' : 'people'}` : 'None', named > 0),
    credentialRow('Music model', data.music, draft.musicConnected, 'Connected', 'Not connected'),
    draft.ceiling.enabled
      ? row('Tracks / day', `${draft.ceiling.dailyTracks} Tracks`, true)
      : row('Tracks / day', 'No limit', false),
    credentialRow('Writing AI', data.llm, draft.llmConnected, draft.llmModel || 'Connected', 'Off'),
    // Having no source is what a Session falls back to when nothing was chosen,
    // so it is the one value that reads as unset.
    row('Cover images', COVER_SOURCE_LABELS[covers], covers !== 'none'),
  ];
}
