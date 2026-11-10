import { describe, expect, it } from 'vitest';
import {
  buildMemberSettingsHubData,
  buildSettingsHubData,
  credentialState,
  type SettingsHubInput,
} from './settings-hub-model';

function configuredInput(): SettingsHubInput {
  return {
    tracksPerCall: 2,
    unitCosts: { ok: true, value: { perTrackUsd: 0.07, perCoverUsd: 0.04 } },
    usage: {
      ok: true,
      value: {
        dailyTracksUsed: 8,
        dailyTracksLimit: 40,
        monthlyTracksUsed: 122,
        monthlyTracksLimit: 400,
      },
    },
    limits: {
      ok: true,
      value: {
        dailyGenerationTasks: 20,
        monthlyGenerationTasks: 200,
        maxConcurrentJobs: 1,
        maxQueuedTracks: 10,
        minHeadroomTracksToStartSession: 5,
        storageQuotaBytes: 5 * 1024 ** 3,
        resetTimezone: 'Europe/Berlin',
        tailoredCoverArtEnabled: true,
        trackCeilingEnabled: true,
      },
    },
    coverUsage: {
      ok: true,
      value: { dailyUsed: 3, dailyLimit: 20, monthlyUsed: 14, monthlyLimit: 100 },
    },
    providers: {
      ok: true,
      value: {
        music: { label: 'Configured', tone: 'ok' },
        llm: null,
        covers: { label: 'Environment', tone: 'ok' },
      },
    },
    imageProvider: { selected: true, configured: true, sunoFallbackConfigured: false },
    generation: {
      ok: true,
      value: { bufferEnabled: true, bufferAheadTracks: 3, defaultLanguage: 'auto' },
    },
    playback: { ok: true, value: { blendEnabled: true, crossfadeSeconds: 8 } },
    coverArt: { ok: true, value: { defaultStyle: 'photographic' } },
    profile: {
      ok: true,
      value: { name: 'Admin', city: 'Berlin', country: 'Germany' },
    },
    peopleCount: { ok: true, value: 1 },
    storageProviderKey: { ok: true, value: 'local' },
    worker: { ok: true, value: { health: 'healthy' as const, heartbeatAgo: '8 s ago' } },
    voiceStatus: { ok: true, value: null },
    assistantTone: { ok: true, value: '' },
  };
}

describe('Settings hub model', () => {
  it('offers the My voice row only when the voice status was read', () => {
    const input = configuredInput();
    expect(buildSettingsHubData(input).voice).not.toBeNull();
    input.voiceStatus = null;
    expect(buildSettingsHubData(input).voice).toBeNull();
  });

  it('offers the Assistant row only to a user who has the Assistant, and says whose tone it speaks in', () => {
    const input = configuredInput();
    expect(buildSettingsHubData(input).assistant).toEqual({
      status: { label: 'Default', tone: 'muted' },
      text: "Roadie's own tone",
    });
    input.assistantTone = { ok: true, value: 'Talk like a ship captain.' };
    expect(buildSettingsHubData(input).assistant).toEqual({
      status: { label: 'Custom', tone: 'ok' },
      text: 'Your own tone',
    });
    input.assistantTone = { ok: false };
    expect(buildSettingsHubData(input).assistant?.status.tone).toBe('warn');
    input.assistantTone = null;
    expect(buildSettingsHubData(input).assistant).toBeNull();
  });

  it('provides configured prices for usage and keeps counts when prices cannot be read', () => {
    const input = configuredInput();
    expect(buildSettingsHubData(input).unitCosts).toEqual({ perTrackUsd: 0.07, perCoverUsd: 0.04 });
    input.unitCosts = { ok: false };
    const unavailable = buildSettingsHubData(input);
    expect(unavailable.unitCosts).toBeNull();
    expect(unavailable.meters[0]).toMatchObject({ used: 8, limit: 40 });
  });

  it('projects listener-facing Track and Cover usage from configured sources', () => {
    const result = buildSettingsHubData(configuredInput());

    expect(result.meters).toEqual([
      { label: 'Today', used: 8, limit: 40, suffix: 'Tracks' },
      { label: 'This month', used: 122, limit: 400, suffix: 'Tracks' },
      { label: 'Covers today', used: 3, limit: 20, suffix: 'Covers' },
      { label: 'Covers this month', used: 14, limit: 100, suffix: 'Covers' },
    ]);
    expect(result.generation.text).toContain('40 Tracks/day');
    expect(result.generation.text).toContain('3 ahead');
    expect(result.generation.text).toContain('Auto language');
    expect(result.limits.text).toContain('2 Tracks generating at once');
    expect(result.providers.status).toEqual({ label: 'Configured', tone: 'ok' });
    expect(JSON.stringify(result)).not.toMatch(/secret|masked|api[_ -]?key/i);
  });

  it('shows Track usage without a limit when the Admin Track ceiling is off', () => {
    const input = configuredInput();
    input.usage = {
      ok: true,
      value: {
        dailyTracksUsed: 8,
        dailyTracksLimit: null,
        monthlyTracksUsed: 122,
        monthlyTracksLimit: null,
      },
    };
    if (input.limits.ok) input.limits.value.trackCeilingEnabled = false;

    const result = buildSettingsHubData(input);

    expect(result.meters.slice(0, 2)).toEqual([
      { label: 'Today', used: 8, limit: null, suffix: 'Tracks' },
      { label: 'This month', used: 122, limit: null, suffix: 'Tracks' },
    ]);
    expect(result.generation.text).toContain('No Track ceiling');
    expect(result.generation.text).not.toContain('Tracks/day');
  });

  it('shows Cover usage without a limit when the Admin Cover ceiling is off', () => {
    const input = configuredInput();
    input.coverUsage = {
      ok: true,
      value: { dailyUsed: 3, dailyLimit: null, monthlyUsed: 14, monthlyLimit: null },
    };

    expect(buildSettingsHubData(input).meters.slice(2)).toEqual([
      { label: 'Covers today', used: 3, limit: null, suffix: 'Covers' },
      { label: 'Covers this month', used: 14, limit: null, suffix: 'Covers' },
    ]);
  });

  it('reports generated covers as available via Suno whenever tailored cover art cannot run', () => {
    const input = configuredInput();
    input.imageProvider = { selected: false, configured: false, sunoFallbackConfigured: false };

    expect(buildSettingsHubData(input).coverArt.text).toContain('generated covers unavailable');

    input.imageProvider = { selected: false, configured: false, sunoFallbackConfigured: true };
    expect(buildSettingsHubData(input).coverArt.text).toContain(
      'generated covers available via Suno',
    );

    // A configured image provider still loses the copy while the switch is off.
    input.imageProvider = { selected: true, configured: true, sunoFallbackConfigured: true };
    if (input.limits.ok) {
      input.limits = {
        ok: true,
        value: { ...input.limits.value, tailoredCoverArtEnabled: false },
      };
    }
    expect(buildSettingsHubData(input).coverArt.text).toContain(
      'generated covers available via Suno',
    );

    if (input.limits.ok) {
      input.limits = { ok: true, value: { ...input.limits.value, tailoredCoverArtEnabled: true } };
    }
    expect(buildSettingsHubData(input).coverArt.text).toContain('generated covers available');
  });

  it('names the owner default language in the generation summary when one is set', () => {
    const input = configuredInput();
    input.generation = {
      ok: true,
      value: { bufferEnabled: true, bufferAheadTracks: 3, defaultLanguage: 'German' },
    };

    expect(buildSettingsHubData(input).generation.text).toContain('German language');
  });

  it('summarizes a disabled Buffer default without presenting the retained target as active', () => {
    const input = configuredInput();
    input.generation = {
      ok: true,
      value: { bufferEnabled: false, bufferAheadTracks: 7, defaultLanguage: 'auto' },
    };

    const summary = buildSettingsHubData(input).generation.text;

    expect(summary).toContain('repeat by default');
    expect(summary).not.toContain('7 ahead');
  });

  it('distinguishes environment, absent, and failed validation credential states', () => {
    expect(credentialState({ source: 'env', decryptError: false, validationStatus: 'ok' })).toEqual(
      { label: 'Environment', tone: 'ok' },
    );
    expect(
      credentialState({ source: 'env', decryptError: false, validationStatus: 'rejected' }),
    ).toEqual({ label: 'Environment', tone: 'ok' });
    expect(credentialState({ source: null, decryptError: false })).toEqual({
      label: 'Unavailable',
      tone: 'muted',
    });
    expect(
      credentialState({ source: 'database', decryptError: false, validationStatus: 'failed' }),
    ).toEqual({ label: 'Unhealthy', tone: 'warn' });
  });

  it('marks failed reads unhealthy while keeping optional absent features unavailable', () => {
    const input = configuredInput();
    input.generation = { ok: false };
    input.profile = { ok: false };
    input.storageProviderKey = { ok: false };
    input.providers = {
      ok: true,
      value: {
        music: { label: 'Unhealthy', tone: 'warn' },
        llm: null,
        covers: { label: 'Unavailable', tone: 'muted' },
      },
    };
    input.imageProvider = { selected: false, configured: false, sunoFallbackConfigured: false };

    const result = buildSettingsHubData(input);

    expect(result.generation.status).toEqual({ label: 'Unhealthy', tone: 'warn' });
    expect(result.profile.status).toEqual({ label: 'Unhealthy', tone: 'warn' });
    expect(result.storage.status).toEqual({ label: 'Unhealthy', tone: 'warn' });
    expect(result.providers.status).toEqual({ label: 'Unhealthy', tone: 'warn' });
    expect(result.llm.status).toEqual({ label: 'Unavailable', tone: 'muted' });
  });

  it('uses effective LLM state for a working keyless provider', () => {
    const input = configuredInput();
    if (!input.providers.ok) throw new Error('Configured fixture must include providers');
    const music = input.providers.value.music;
    input.providers = {
      ok: true,
      value: {
        music,
        llm: {
          providerKey: 'ollama',
          status: { label: 'Configured', tone: 'ok' },
        },
        covers: { label: 'Environment', tone: 'ok' },
      },
    };

    const result = buildSettingsHubData(input);
    expect(result.llm.status).toEqual({ label: 'Configured', tone: 'ok' });
    expect(result.providers.text).toContain('Writing AI Configured');
  });
});

describe('Member settings hub model', () => {
  const memberInput = () => {
    const { generation, playback, profile, peopleCount, assistantTone } = configuredInput();
    return { generation, playback, profile, peopleCount, assistantTone };
  };

  it('carries exactly the Member-owned entries', () => {
    const result = buildMemberSettingsHubData(memberInput());
    expect(Object.keys(result).sort()).toEqual([
      'assistant',
      'generation',
      'people',
      'playback',
      'profile',
    ]);
  });

  it('summarizes generation without any instance limit values', () => {
    const result = buildMemberSettingsHubData(memberInput());
    expect(result.generation.text).toBe('3 ahead · Auto language');
    // The admin hub's generation line carries Track-ceiling numbers; the
    // Member's must not — those are instance configuration.
    expect(result.generation.text).not.toMatch(/Tracks/);
  });

  it('keeps the admin hub unchanged for the same sources', () => {
    const admin = buildSettingsHubData(configuredInput());
    const member = buildMemberSettingsHubData(memberInput());
    expect(member.profile).toEqual(admin.profile);
    expect(member.people).toEqual(admin.people);
    expect(member.playback).toEqual(admin.playback);
  });

  it('offers a Member the Assistant row only when they have the Assistant', () => {
    expect(buildMemberSettingsHubData(memberInput()).assistant?.text).toBe("Roadie's own tone");
    expect(
      buildMemberSettingsHubData({ ...memberInput(), assistantTone: null }).assistant,
    ).toBeNull();
  });

  it('degrades per entry when a source is unreadable', () => {
    const input = { ...memberInput(), generation: { ok: false as const } };
    const result = buildMemberSettingsHubData(input);
    expect(result.generation.status.tone).toBe('warn');
    expect(result.playback.status.tone).toBe('ok');
  });
});
