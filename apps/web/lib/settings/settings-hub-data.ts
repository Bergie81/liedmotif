import {
  countPeople,
  getAssistantTone,
  getCoverArtSettings,
  getAdminCoverUsage,
  getGenerationSettings,
  getPlaybackSettings,
  getUnitCosts,
  getUsageLimits,
  getVoiceProfile,
  readWorkerHeartbeat,
  workerHeartbeatHealth,
  type UserRole,
} from '@liedmotif/db';
import { createLogger } from '@liedmotif/shared';
import { cachedAssistantAvailability } from '@/lib/assistant/availability';
import { sunoCoverFallbackConfigured } from '@/lib/covers/covers';
import { getDb } from '@/lib/db';
import { getStorageProvider, getTypicalTracksPerMusicRequest } from '@/lib/providers/providers';
import { cachedListenerProfile, requestNow } from '@/lib/request-cache';
import { cachedOwnerUsageTracks } from '@/lib/sessions/sessions';
import { loadProviderSettingsData } from '@/lib/settings/provider-settings-data';
import { ownVoiceEnabled } from '@/lib/env';
import { formatSecondsAgo } from '@/lib/admin/worker-diagnostics-model';
import {
  buildMemberSettingsHubData,
  buildSettingsHubData,
  type MemberSettingsHubData,
  type SettingsHubData,
  type SettingsHubInput,
  type SettingsHubRead,
} from '@/lib/settings/settings-hub-model';

export type {
  MemberSettingsHubData,
  SettingsHubData,
  SettingsHubMeter,
} from '@/lib/settings/settings-hub-model';

const logger = createLogger({ name: 'settings-hub' });

async function read<T>(
  source: string,
  operation: () => Promise<T> | T,
): Promise<SettingsHubRead<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch {
    logger.warn('Settings summary source could not be read', { source });
    return { ok: false };
  }
}

async function loadUsageSection(
  ownerUserId: string,
  tracksPerCall: number,
  now: Date,
): Promise<Pick<SettingsHubInput, 'usage' | 'limits' | 'coverUsage' | 'unitCosts'>> {
  const db = getDb();
  const [limits, unitCosts] = await Promise.all([
    read('usage-limits', () => getUsageLimits(db)),
    read('unit-costs', () => getUnitCosts(db)),
  ]);
  if (!limits.ok) return { limits, unitCosts, usage: { ok: false }, coverUsage: { ok: false } };

  const [usage, coverUsage] = await Promise.all([
    // Request-cached: the app layout runs the same computation for the chrome,
    // and both readouts must come from one `now`.
    read('music-usage', () => cachedOwnerUsageTracks(db, ownerUserId, tracksPerCall)),
    // The viewer's OWN cover spend, counted by the same function admission
    // enforces, so this indicator can never disagree with a refusal.
    read('cover-usage', async () => {
      const cover = await getAdminCoverUsage(db, {
        ownerUserId,
        instanceLimits: limits.value,
        now,
        concurrently: true,
      });
      return {
        dailyUsed: cover.usedDay,
        dailyLimit: cover.limitDay,
        monthlyUsed: cover.usedMonth,
        monthlyLimit: cover.limitMonth,
      };
    }),
  ]);
  return { limits, unitCosts, usage, coverUsage };
}

async function loadProviderSection(): Promise<
  Pick<SettingsHubInput, 'providers' | 'imageProvider'>
> {
  const providers = await read('providers', async () => {
    const value = await loadProviderSettingsData();
    return {
      music: value.music.status,
      llm: value.llm.credential
        ? { providerKey: value.llm.providerKey, status: value.llm.presentation.status }
        : null,
      covers: value.cover.status,
    };
  });
  return {
    providers,
    imageProvider: {
      selected: providers.ok && providers.value.covers.label !== 'Unavailable',
      configured: providers.ok && providers.value.covers.tone === 'ok',
      sunoFallbackConfigured: await sunoCoverFallbackConfigured(),
    },
  };
}

async function loadGenerationSection(
  ownerUserId: string,
): Promise<Pick<SettingsHubInput, 'generation' | 'playback' | 'coverArt'>> {
  const db = getDb();
  const [generation, playback, coverArt] = await Promise.all([
    read('generation', () => getGenerationSettings(db, ownerUserId)),
    read('playback', () => getPlaybackSettings(db, ownerUserId)),
    read('cover-art', () => getCoverArtSettings(db, ownerUserId)),
  ]);
  return { generation, playback, coverArt };
}

async function loadAccountSection(
  ownerUserId: string,
): Promise<
  Pick<
    SettingsHubInput,
    'profile' | 'peopleCount' | 'storageProviderKey' | 'worker' | 'voiceStatus'
  >
> {
  const db = getDb();
  const [profile, peopleCount, storageProviderKey, worker, voiceStatus] = await Promise.all([
    read('profile', () => cachedListenerProfile(db, ownerUserId)),
    read('people', () => countPeople(db, ownerUserId)),
    read('storage', () => getStorageProvider().providerKey),
    read('worker', async () => {
      const nowMs = Date.now();
      const record = await readWorkerHeartbeat(db);
      return {
        health: workerHeartbeatHealth(record, nowMs),
        heartbeatAgo: record ? formatSecondsAgo(record.ts, nowMs) : null,
      };
    }),
    ownVoiceEnabled()
      ? read('voice', async () => (await getVoiceProfile(db, ownerUserId))?.status ?? null)
      : null,
  ]);
  return { profile, peopleCount, storageProviderKey, worker, voiceStatus };
}

/** The user's tone for the Assistant row, read only for a user who has the Assistant. */
async function loadAssistantTone(
  ownerUserId: string,
  role: UserRole,
): Promise<SettingsHubInput['assistantTone']> {
  const db = getDb();
  const { available } = await cachedAssistantAvailability(db, ownerUserId, role);
  if (!available) return null;
  return read('assistant-tone', async () => (await getAssistantTone(db, ownerUserId)).tone);
}

export async function loadSettingsHubData(ownerUserId: string): Promise<SettingsHubData> {
  const tracksPerCall = getTypicalTracksPerMusicRequest();
  // The shared request clock: the cover-usage windows here count from the same
  // instant as the request-cached music-usage computation.
  const now = requestNow();
  const [usage, providers, generation, account, assistantTone] = await Promise.all([
    loadUsageSection(ownerUserId, tracksPerCall, now),
    loadProviderSection(),
    loadGenerationSection(ownerUserId),
    loadAccountSection(ownerUserId),
    loadAssistantTone(ownerUserId, 'admin'),
  ]);
  return buildSettingsHubData({
    tracksPerCall,
    ...usage,
    ...providers,
    ...generation,
    ...account,
    assistantTone,
  });
}

/**
 * The Member hub reads only the Member's own settings — no instance limits,
 * providers, or storage state is loaded, so none of it can leak into
 * the payload a Member receives.
 */
export async function loadMemberSettingsHubData(
  ownerUserId: string,
): Promise<MemberSettingsHubData> {
  const db = getDb();
  const [generation, playback, coverArt, profile, peopleCount, assistantTone] = await Promise.all([
    read('generation', () => getGenerationSettings(db, ownerUserId)),
    read('playback', () => getPlaybackSettings(db, ownerUserId)),
    read('cover-art', () => getCoverArtSettings(db, ownerUserId)),
    read('profile', () => cachedListenerProfile(db, ownerUserId)),
    read('people', () => countPeople(db, ownerUserId)),
    loadAssistantTone(ownerUserId, 'member'),
  ]);
  return buildMemberSettingsHubData({
    generation,
    playback,
    coverArt,
    profile,
    peopleCount,
    assistantTone,
  });
}
