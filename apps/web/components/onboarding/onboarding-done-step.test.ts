import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OnboardingUntouched } from '@/lib/onboarding-data';
import { OnboardingDoneStep } from './onboarding-done-step';

function renderDone(overrides: Partial<OnboardingUntouched> = {}) {
  const untouched: OnboardingUntouched = {
    playback: { blendEnabled: true, crossfadeSeconds: 6 },
    generation: { bufferEnabled: true, bufferAheadTracks: 3, defaultLanguage: 'auto' },
    coverStyle: 'auto',
    ownVoiceOffer: 'setup',
    accountEmail: false,
    storageProvider: 'local-fs',
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(OnboardingDoneStep, { untouched }));
}

describe('onboarding done step', () => {
  beforeAll(() => vi.stubGlobal('React', React));
  afterAll(() => vi.unstubAllGlobals());

  // Email has no screen of its own and no Settings page, so this row is where
  // the Admin learns it exists and which two `.env` lines turn it on.
  it('names the two .env lines that turn account email on while it is off', () => {
    const markup = renderDone({ accountEmail: false });

    expect(markup).toContain('Account email off');
    expect(markup).toContain('SMTP_URL');
    expect(markup).toContain('MAIL_FROM');
  });

  it('reports account email on without the setup hint', () => {
    const markup = renderDone({ accountEmail: true });

    expect(markup).toContain('Account email on');
    expect(markup).not.toContain('SMTP_URL');
  });

  it('reports the singing voice by its offer, and leaves the row out when hidden', () => {
    expect(renderDone({ ownVoiceOffer: 'setup' })).toContain('Your singing voice not set up');
    expect(renderDone({ ownVoiceOffer: 'ready' })).toContain('Your singing voice is ready');
    expect(renderDone({ ownVoiceOffer: 'hidden' })).not.toContain('singing voice');
  });

  it('names the storage backend the instance actually writes to', () => {
    expect(renderDone({ storageProvider: 'local-fs' })).toContain('Tracks stored on local disk');
    expect(renderDone({ storageProvider: 's3' })).toContain('Tracks stored in an S3 bucket');
  });
});
