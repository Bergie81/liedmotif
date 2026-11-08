import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultUsageLimits } from '@liedmotif/db';
import { expect, it } from 'vitest';
import { AppChromeContext, type AppChromeContextValue } from '@/components/app-chrome-context';
import { LimitsForm } from './limits-form';

const chrome: AppChromeContextValue = {
  listener: { name: 'Admin', email: 'admin@example.test', artistName: null, imageUrl: null },
  viewerRole: 'admin',
  ownVoiceOffered: false,
  themeMode: 'night',
  onToggleThemeMode: () => {},
  fetchChrome: () => new Promise(() => {}),
};

it('shows the admin generation ceilings in Tracks and Covers with bracketed dollar estimates', () => {
  const initial = {
    ...defaultUsageLimits(),
    dailyGenerationTasks: 20,
    monthlyGenerationTasks: 200,
    generatedCoversPerDay: 20,
    generatedCoversPerMonth: 100,
  };
  const html = renderToStaticMarkup(
    createElement(
      AppChromeContext.Provider,
      { value: chrome },
      createElement(LimitsForm, {
        initial,
        tracksPerRequest: 2,
        unitCosts: { perTrackUsd: 0.07, perCoverUsd: 0.04 },
      }),
    ),
  );
  const text = html.replace(/<[^>]*>/g, '');
  expect(text).toContain('40 Tracks ($2.80)');
  expect(text).toContain('400 Tracks ($28.00)');
  expect(text).toContain('20 Covers ($0.80)');
  expect(text).toContain('100 Covers ($4.00)');
});
