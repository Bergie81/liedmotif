// Parity guard for the contract DOMAIN vocabularies (feedback type, persisted
// playback event type, vocal mode, provider type): the `@liedmotif/shared`
// contract enums MUST hold exactly the live Drizzle `pgEnum` values. Independent
// declarations bound by a static, connection-free check so they can never drift.
//
// `ENERGY_LEVELS` and the playback `position` report type are intentionally NOT
// checked here: energy is stored as free `text` (no enum) and `position` is a
// live-only report that is never persisted, so neither has a DB counterpart.

import {
  ANALYSIS_STATUSES,
  BPM_SOURCES,
  COVER_STYLES,
  FEEDBACK_TYPES,
  PERSISTED_PLAYBACK_EVENT_TYPES,
  PROVIDER_TYPES,
  VOCAL_MODES,
} from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import {
  analysisStatus,
  bpmSource,
  coverStyle,
  feedbackType,
  playbackEventType,
  providerType,
  vocalMode,
} from './enums';

describe('contract-domain ↔ pgEnum parity', () => {
  const cases: ReadonlyArray<{ name: string; shared: readonly string[]; db: readonly string[] }> = [
    { name: 'feedbackType', shared: FEEDBACK_TYPES, db: feedbackType.enumValues },
    {
      name: 'playbackEventType',
      shared: PERSISTED_PLAYBACK_EVENT_TYPES,
      db: playbackEventType.enumValues,
    },
    { name: 'vocalMode', shared: VOCAL_MODES, db: vocalMode.enumValues },
    { name: 'providerType', shared: PROVIDER_TYPES, db: providerType.enumValues },
    { name: 'coverStyle', shared: COVER_STYLES, db: coverStyle.enumValues },
    { name: 'analysisStatus', shared: ANALYSIS_STATUSES, db: analysisStatus.enumValues },
    { name: 'bpmSource', shared: BPM_SOURCES, db: bpmSource.enumValues },
  ];

  for (const { name, shared, db } of cases) {
    it(`${name}: shared contract enum holds exactly the pgEnum values`, () => {
      expect([...shared].sort()).toEqual([...db].sort());
    });
  }

  it('feedback type has no `like` on either side', () => {
    expect(FEEDBACK_TYPES).not.toContain('like');
    expect(feedbackType.enumValues).not.toContain('like');
  });
});
