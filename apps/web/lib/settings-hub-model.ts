import { unitCostsSet, type CoverStyleChoice, type UnitCosts } from '@liedmotif/shared';
import type { CredentialSource, VoiceProfileStatus } from '@liedmotif/db';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { coverSource, type CoverSource } from '@/lib/cover-source';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import type { DiagnosticHealth } from '@/lib/storage-diagnostics-model';
import { formatBinaryBytes } from '@/lib/format-bytes';
import { sessionLanguageLabel, type SessionLanguageChoice } from '@/lib/session-languages';
import { providerTasksToTracks } from '@/lib/track-units';

export type SettingsStatusTone = 'ok' | 'warn' | 'muted';
export interface SettingsStatus {
  label: string;
  tone: SettingsStatusTone;
}

export interface SettingsHubMeter {
  label: string;
  used: number;
  /** `null`: counted, but nothing caps it (the Admin with the Track ceiling off). */
  limit: number | null;
  suffix: 'Tracks' | 'Covers';
}

export interface SettingsHubSummary {
  status: SettingsStatus;
  text: string;
}

export interface SettingsHubData {
  meters: SettingsHubMeter[];
  unitCosts: UnitCosts | null;
  usageNote: string;
  providers: SettingsHubSummary;
  llm: SettingsHubSummary;
  generation: SettingsHubSummary;
  limits: SettingsHubSummary;
  playback: SettingsHubSummary;
  /** Null while the own-voice feature is switched off — the row is not offered. */
  voice: SettingsHubSummary | null;
  coverArt: SettingsHubSummary;
  profile: SettingsHubSummary;
  people: SettingsHubSummary;
  /** Null for a user who has no Assistant — the row is not offered. */
  assistant: SettingsHubSummary | null;
  storage: SettingsHubSummary;
  diagnostics: SettingsHubSummary;
}

export type SettingsHubRead<T> = { ok: true; value: T } | { ok: false };

export interface SettingsHubInput {
  tracksPerCall: number;
  unitCosts: SettingsHubRead<UnitCosts>;
  usage: SettingsHubRead<{
    dailyTracksUsed: number;
    dailyTracksLimit: number | null;
    monthlyTracksUsed: number;
    monthlyTracksLimit: number | null;
  }>;
  limits: SettingsHubRead<{
    dailyGenerationTasks: number;
    monthlyGenerationTasks: number;
    maxConcurrentJobs: number;
    maxQueuedTracks: number;
    minHeadroomTracksToStartSession: number;
    storageQuotaBytes: number;
    resetTimezone: string;
    tailoredCoverArtEnabled: boolean;
    trackCeilingEnabled: boolean;
  }>;
  coverUsage: SettingsHubRead<{
    dailyUsed: number;
    dailyLimit: number | null;
    monthlyUsed: number;
    monthlyLimit: number | null;
  }>;
  providers: SettingsHubRead<{
    music: SettingsStatus;
    llm: { providerKey: string; status: SettingsStatus } | null;
    covers: SettingsStatus;
  }>;
  imageProvider: {
    selected: boolean;
    configured: boolean;
    /** The Suno cover fallback is buildable (Suno music provider with a key). */
    sunoFallbackConfigured: boolean;
  };
  generation: SettingsHubRead<{
    bufferEnabled: boolean;
    bufferAheadTracks: number;
    defaultLanguage: SessionLanguageChoice;
  }>;
  playback: SettingsHubRead<{ blendEnabled: boolean; crossfadeSeconds: number }>;
  coverArt: SettingsHubRead<{ defaultStyle: CoverStyleChoice }>;
  profile: SettingsHubRead<{
    name: string | null;
    city: string | null;
    country: string | null;
  } | null>;
  /** The voice-profile status (value null when none exists), or null itself
   * while the own-voice feature is switched off and nothing was read. */
  voiceStatus: SettingsHubRead<VoiceProfileStatus | null> | null;
  peopleCount: SettingsHubRead<number>;
  /** The tone the user gave the Assistant (empty when none), or null itself
   * for a user who has no Assistant and nothing was read. */
  assistantTone: SettingsHubRead<string> | null;
  storageProviderKey: SettingsHubRead<string>;
  /** Heartbeat-derived worker status, precomputed server-side (this module stays client-safe). */
  worker: SettingsHubRead<{ health: DiagnosticHealth; heartbeatAgo: string | null }>;
}

/**
 * The Member hub payload: exactly the entries a Member owns, and nothing else.
 * A separate, narrower type (rather than a filtered `SettingsHubData`) so an
 * instance-scoped summary value cannot reach a Member's hub by construction —
 * there is no field to put it in.
 */
export interface MemberSettingsHubData {
  profile: SettingsHubSummary;
  people: SettingsHubSummary;
  /** Null for a Member who has no Assistant — the row is not offered. */
  assistant: SettingsHubSummary | null;
  generation: SettingsHubSummary;
  playback: SettingsHubSummary;
  coverArt: SettingsHubSummary;
}

export type MemberSettingsHubInput = Pick<
  SettingsHubInput,
  'generation' | 'playback' | 'coverArt' | 'profile' | 'peopleCount' | 'assistantTone'
>;

export function credentialState(input: {
  source: CredentialSource | null;
  decryptError: boolean;
  validationStatus?: string | null;
}): SettingsStatus {
  if (input.source === 'env') return { label: 'Environment', tone: 'ok' };
  if (input.decryptError || (input.validationStatus && input.validationStatus !== 'ok')) {
    return { label: 'Unhealthy', tone: 'warn' };
  }
  if (input.source === 'database') return { label: 'Configured', tone: 'ok' };
  return { label: 'Unavailable', tone: 'muted' };
}

const unavailable = (text = 'Unavailable'): SettingsHubSummary => ({
  status: { label: 'Unavailable', tone: 'muted' },
  text,
});

const unhealthy = (text: string): SettingsHubSummary => ({
  status: { label: 'Unhealthy', tone: 'warn' },
  text,
});

const configured = (text: string): SettingsHubSummary => ({
  status: { label: 'Configured', tone: 'ok' },
  text,
});

/** How the cover-art row names each source. Only "no source" reads as a gap. */
const COVER_AVAILABILITY: Record<CoverSource, string> = {
  image: 'available',
  'music-provider': 'available via Suno',
  none: 'unavailable',
};

/** Heartbeat-derived hub line: label/tone from health, age when one exists. */
function workerSummary(worker: SettingsHubInput['worker']): SettingsHubSummary {
  if (!worker.ok) return unhealthy('Worker status could not be read');
  const { health, heartbeatAgo } = worker.value;
  switch (health) {
    case 'healthy':
      return {
        status: { label: 'Worker healthy', tone: 'ok' },
        text: `Heartbeat ${heartbeatAgo}`,
      };
    case 'degraded':
    case 'misconfigured':
      return {
        status: { label: 'Worker degraded', tone: 'warn' },
        text: heartbeatAgo ? `Heartbeat ${heartbeatAgo}` : 'Worker cannot run jobs',
      };
    case 'unavailable':
      return {
        status: { label: 'Worker unavailable', tone: 'muted' },
        text: 'The worker has never reported a heartbeat',
      };
  }
}

function voiceSummary(voiceStatus: SettingsHubRead<VoiceProfileStatus | null>): SettingsHubSummary {
  if (!voiceStatus.ok) return unavailable('Voice profile could not be read');
  switch (voiceStatus.value) {
    case null:
      return unavailable('Record your voice to sing in vocal Sessions');
    case 'ready':
      return configured('My voice is ready');
    case 'disabled':
      return { status: { label: 'Disabled', tone: 'muted' }, text: 'Kept but not offered' };
    case 'failed':
      return unhealthy('Voice setup failed — retry with a new recording');
    default:
      return { status: { label: 'In progress', tone: 'ok' }, text: 'Voice setup in progress' };
  }
}

function providerSummary(input: SettingsHubInput): SettingsHubSummary {
  if (!input.providers.ok) return unhealthy('Provider configuration could not be resolved');
  const music = input.providers.value.music;
  const llm = input.providers.value.llm
    ? input.providers.value.llm.status
    : ({ label: 'Unavailable', tone: 'muted' } satisfies SettingsStatus);
  const covers = input.providers.value.covers;
  const hasUnhealthy = [music, llm, covers].some((item) => item.tone === 'warn');
  const status = hasUnhealthy ? { label: 'Unhealthy', tone: 'warn' as const } : music;
  return {
    status,
    text: `Music ${music.label} · Text AI ${llm.label} · Covers ${covers.label}`,
  };
}

/** The generation row's buffer + language wording, shared by both hubs. */
function generationPhrases(generation: SettingsHubInput['generation']): {
  bufferSummary: string;
  languageSummary: string;
} {
  // The hub line wants the short "Auto", not the select's "Auto Detect".
  const languageSummary = generation.ok
    ? generation.value.defaultLanguage === 'auto'
      ? 'Auto'
      : sessionLanguageLabel(generation.value.defaultLanguage)
    : '';
  const bufferSummary = generation.ok
    ? generation.value.bufferEnabled
      ? `${generation.value.bufferAheadTracks} ahead`
      : 'repeat by default'
    : '';
  return { bufferSummary, languageSummary };
}

function playbackSummary(playback: SettingsHubInput['playback']): SettingsHubSummary {
  return !playback.ok
    ? unhealthy('Playback settings could not be read')
    : configured(
        `Blend ${playback.value.blendEnabled ? 'on' : 'off'} · ${playback.value.crossfadeSeconds} s crossfade`,
      );
}

function profileSummary(profile: SettingsHubInput['profile']): SettingsHubSummary {
  return !profile.ok
    ? unhealthy('Profile could not be read')
    : profile.value
      ? configured(
          [profile.value.name || 'Unnamed user', profile.value.city, profile.value.country]
            .filter(Boolean)
            .join(' · '),
        )
      : unavailable('Profile not completed');
}

function peopleSummary(peopleCount: SettingsHubInput['peopleCount']): SettingsHubSummary {
  return !peopleCount.ok
    ? unhealthy('People could not be read')
    : configured(
        `${peopleCount.value} ${peopleCount.value === 1 ? 'Person' : 'People'} configured`,
      );
}

/** The Assistant row: whose tone it answers in, for a user who has the Assistant. */
function assistantSummary(tone: SettingsHubInput['assistantTone']): SettingsHubSummary | null {
  if (!tone) return null;
  if (!tone.ok) return unhealthy('Tone could not be read');
  return tone.value
    ? { status: { label: 'Custom', tone: 'ok' }, text: 'Your own tone' }
    : { status: { label: 'Default', tone: 'muted' }, text: `${ASSISTANT_NAME}'s own tone` };
}

/**
 * The Member hub: personal settings only. The generation row deliberately
 * carries no Track-ceiling numbers — those are budget figures and belong to
 * Settings → My budget, in the Member's own terms.
 */
export function buildMemberSettingsHubData(input: MemberSettingsHubInput): MemberSettingsHubData {
  const { bufferSummary, languageSummary } = generationPhrases(input.generation);
  return {
    profile: profileSummary(input.profile),
    people: peopleSummary(input.peopleCount),
    assistant: assistantSummary(input.assistantTone),
    generation: !input.generation.ok
      ? unhealthy('Generation settings could not be read')
      : configured(`${bufferSummary} · ${languageSummary} language`),
    playback: playbackSummary(input.playback),
    // Which cover source runs is instance configuration, so a Member's row names
    // only their own default style.
    coverArt: !input.coverArt.ok
      ? unhealthy('Cover-art settings could not be read')
      : configured(`Default ${COVER_STYLE_LABELS[input.coverArt.value.defaultStyle]}`),
  };
}

function trackCeilingSummary(
  limits: {
    trackCeilingEnabled: boolean;
    dailyGenerationTasks: number;
    monthlyGenerationTasks: number;
  },
  tracksPerCall: number,
): string {
  if (!limits.trackCeilingEnabled) return 'No Track ceiling';
  return `${providerTasksToTracks(limits.dailyGenerationTasks, tracksPerCall)} Tracks/day · ${providerTasksToTracks(limits.monthlyGenerationTasks, tracksPerCall)} Tracks/month`;
}

export function buildSettingsHubData(input: SettingsHubInput): SettingsHubData {
  const meters: SettingsHubMeter[] = [];
  if (input.usage.ok) {
    meters.push(
      {
        label: 'Today',
        used: input.usage.value.dailyTracksUsed,
        limit: input.usage.value.dailyTracksLimit,
        suffix: 'Tracks',
      },
      {
        label: 'This month',
        used: input.usage.value.monthlyTracksUsed,
        limit: input.usage.value.monthlyTracksLimit,
        suffix: 'Tracks',
      },
    );
  }
  if (input.coverUsage.ok) {
    meters.push(
      {
        label: 'Covers today',
        used: input.coverUsage.value.dailyUsed,
        limit: input.coverUsage.value.dailyLimit,
        suffix: 'Covers',
      },
      {
        label: 'Covers this month',
        used: input.coverUsage.value.monthlyUsed,
        limit: input.coverUsage.value.monthlyLimit,
        suffix: 'Covers',
      },
    );
  }

  const { bufferSummary, languageSummary } = generationPhrases(input.generation);
  const generation =
    !input.generation.ok || !input.limits.ok
      ? unhealthy('Generation settings could not be read')
      : configured(
          `${trackCeilingSummary(input.limits.value, input.tracksPerCall)} · ${bufferSummary} · ${languageSummary} language`,
        );
  const limits = !input.limits.ok
    ? unhealthy('Cost limits could not be read')
    : configured(
        `${providerTasksToTracks(input.limits.value.maxConcurrentJobs, input.tracksPerCall)} Tracks generating at once · ${input.limits.value.maxQueuedTracks} Tracks queued · ${input.limits.value.minHeadroomTracksToStartSession} Tracks headroom`,
      );
  const playback = playbackSummary(input.playback);
  // Unreadable limits count as the switch being off: the hub then reports the
  // source that still runs without it, rather than promising a tailored cover.
  const generatedCoverSource = coverSource({
    imageProviderConfigured: input.imageProvider.configured,
    tailoredCoverArtEnabled: input.limits.ok && input.limits.value.tailoredCoverArtEnabled,
    musicProviderCoverConfigured: input.imageProvider.sunoFallbackConfigured,
  });
  const coverArt = !input.coverArt.ok
    ? unhealthy('Cover-art settings could not be read')
    : configured(
        `Default ${COVER_STYLE_LABELS[input.coverArt.value.defaultStyle]} · generated covers ${COVER_AVAILABILITY[generatedCoverSource]}`,
      );
  const profile = profileSummary(input.profile);
  const people = peopleSummary(input.peopleCount);
  const storage = !input.storageProviderKey.ok
    ? unhealthy('Storage provider could not be resolved')
    : !input.limits.ok
      ? unhealthy(`${input.storageProviderKey.value} · usage unavailable`)
      : configured(
          `${input.storageProviderKey.value} · ${formatBinaryBytes(input.limits.value.storageQuotaBytes)} quota`,
        );
  const diagnostics = workerSummary(input.worker);
  const llm = !input.providers.ok
    ? unhealthy('Text AI configuration could not be resolved')
    : input.providers.value.llm
      ? {
          status: input.providers.value.llm.status,
          text: `${input.providers.value.llm.providerKey} · Optional Text AI`,
        }
      : unavailable('Optional · prompts pass through as written without it');

  const unitCosts = input.unitCosts.ok ? input.unitCosts.value : null;
  const spendNote =
    unitCosts && unitCostsSet(unitCosts) ? ' Costs are estimates at your saved unit prices.' : '';

  return {
    meters,
    unitCosts,
    usageNote: input.limits.ok
      ? `Limits reset in ${input.limits.value.resetTimezone}.${spendNote}`
      : 'Usage limits could not be read.',
    providers: providerSummary(input),
    llm,
    generation,
    limits,
    playback,
    voice: input.voiceStatus ? voiceSummary(input.voiceStatus) : null,
    coverArt,
    profile,
    people,
    assistant: assistantSummary(input.assistantTone),
    storage,
    diagnostics,
  };
}
