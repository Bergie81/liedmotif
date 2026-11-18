import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OnboardingData } from '@/lib/onboarding-data';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { OnboardingWizard } = await import('./onboarding-wizard');

function makeData(overrides: Partial<OnboardingData> = {}): OnboardingData {
  return {
    profile: {
      name: 'John',
      email: 'owner@example.com',
      city: '',
      country: '',
      artistName: '',
      description: '',
    },
    people: {
      initialPeople: [{ id: 'p1', role: 'owner', name: 'John', about: '', photos: [] }],
      initialFrequency: 'regularly',
      maxPeople: 6,
      maxNameLength: 120,
      maxAboutLength: 2_000,
      maxPhotosPerPerson: 3,
      maxPhotosTotal: 18,
    },
    limits: {
      trackCeilingEnabled: true,
      dailyGenerationTasks: 20,
      monthlyGenerationTasks: 200,
      resetTimezone: 'Europe/Berlin',
      maxConcurrentJobs: 1,
      maxQueuedTracks: 6,
      maxSessionMinutesWithoutConfirmation: 60,
      maxRetriesPerJob: 2,
      storageQuotaBytes: 1024,
      manualGenerationOnly: false,
      idleAutoStopAfterMinutes: 15,
      minHeadroomTracksToStartSession: 5,
      tailoredCoverArtEnabled: true,
      coverCeilingEnabled: true,
      generatedCoversPerDay: 20,
      generatedCoversPerMonth: 300,
    },
    tracksPerRequest: 2,
    encryptionKeyConfigured: true,
    music: {
      providerKey: 'suno',
      displayName: 'Suno',
      environmentManaged: false,
      configured: false,
      masked: null,
    },
    llm: {
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      environmentManaged: false,
      configured: false,
      masked: null,
    },
    image: {
      providerKey: 'openrouter',
      displayName: 'OpenRouter',
      environmentManaged: false,
      configured: false,
      masked: null,
    },
    musicProviderCoverConfigured: false,
    untouched: {
      playback: { blendEnabled: true, crossfadeSeconds: 6 },
      generation: { bufferEnabled: true, bufferAheadTracks: 3, defaultLanguage: 'auto' },
      coverStyle: 'auto',
      ownVoiceOffer: 'setup',
      accountEmail: false,
      storageProvider: 'local-fs',
    },
    ...overrides,
  };
}

function render(data: OnboardingData) {
  return renderToStaticMarkup(React.createElement(OnboardingWizard, { data, avatarUrl: null }));
}

describe('first-login onboarding wizard', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  it('opens on the profile step with the whole flow already listed in the rail', () => {
    const markup = render(makeData());

    expect(markup).toContain('Welcome. What should we call you?');
    // Every step is named from the first screen, so the shape is knowable up front.
    for (const title of [
      'You',
      'People',
      'Music model',
      'Track limit',
      'Text AI',
      'Cover art',
    ]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain('Step 1 of 7');
  });

  it('shows the profile it was given, and the name as the MP3 artist fallback', () => {
    const markup = render(makeData());

    expect(markup).toContain('value="owner@example.com"');
    // Two places: the field placeholder and the rail's record.
    expect(markup.match(/John/g)?.length).toBeGreaterThan(1);
  });

  it('renders the whole flow forward only — later steps are not yet reachable', () => {
    const markup = render(makeData());

    // The rail lists Cover art, but nothing past the opening step can be clicked.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]{0,400}?Cover art/);
  });

  it('reports a daily ceiling in Tracks, converted from provider calls', () => {
    // 20 calls x 2 Tracks per call.
    expect(render(makeData())).toContain('40 Tracks');
  });
});
