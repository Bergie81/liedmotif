import { describe, expect, it } from 'vitest';
import type { TrackDetails } from '@liedmotif/shared';
import { buildTrackDataSections } from './track-data-view';

const FULL: TrackDetails = {
  title: 'Rainfall Circuit',
  sessionTitle: 'Deep Focus Coding',
  artistName: 'DJ John',
  createdAt: '2026-07-22T12:00:00.000Z',
  timezone: 'Europe/Berlin',
  durationSeconds: 184,
  userPrompt: 'calm music for late-night coding',
  stylePrompt: 'lofi hip hop, mellow, 80 bpm',
  expandedPrompt: 'A mellow lofi set for deep work…',
  genreTags: ['lofi', 'ambient'],
  activity: 'coding',
  mood: 'calm',
  energy: 'low',
  vocalMode: 'vocal',
  language: 'German',
  bpm: 88,
  providerKey: 'suno',
  providerModel: 'V4_5',
  licenseNote: 'Personal, non-commercial use.',
};

const SPARSE: TrackDetails = {
  title: null,
  sessionTitle: null,
  artistName: 'Test Admin',
  createdAt: '2026-07-22T12:00:00.000Z',
  timezone: 'Europe/Berlin',
  durationSeconds: null,
  userPrompt: null,
  stylePrompt: null,
  expandedPrompt: null,
  genreTags: [],
  activity: null,
  mood: null,
  energy: null,
  vocalMode: 'instrumental',
  language: null,
  bpm: null,
  providerKey: 'mock',
  providerModel: null,
  licenseNote: null,
};

describe('buildTrackDataSections', () => {
  it('builds all four sections from a fully enriched Track', () => {
    const sections = buildTrackDataSections(FULL);
    expect(sections.map((s) => s.title)).toEqual(['Identity', 'Prompts', 'Vibe', 'Provenance']);

    const identity = sections[0]!;
    expect(identity.fields).toEqual([
      { label: 'Title', value: 'Rainfall Circuit' },
      { label: 'Album', value: 'Deep Focus Coding' },
      { label: 'Artist', value: 'DJ John' },
      { label: 'Generated', value: 'Jul 22, 2026' },
      { label: 'Duration', value: '3:04' },
    ]);

    // Prompts are long free text — rendered as wrapping blocks, clearly labeled.
    expect(sections[1]!.fields).toEqual([
      { label: 'Your prompt', value: 'calm music for late-night coding', block: true },
      { label: 'Style prompt', value: 'lofi hip hop, mellow, 80 bpm', block: true },
      { label: 'Expanded prompt', value: 'A mellow lofi set for deep work…', block: true },
    ]);

    expect(sections[2]!.fields).toEqual([
      { label: 'Genres', value: 'lofi, ambient' },
      { label: 'Activity', value: 'coding' },
      { label: 'Mood', value: 'calm' },
      { label: 'Energy', value: 'low' },
      { label: 'Vocals', value: 'Vocal · German' },
      { label: 'BPM', value: '88' },
    ]);

    expect(sections[3]!.fields).toEqual([
      { label: 'Provider', value: 'suno' },
      { label: 'Model', value: 'V4_5' },
      { label: 'License', value: 'Personal, non-commercial use.' },
    ]);
  });

  it('omits absent fields and drops a section with nothing to show', () => {
    const sections = buildTrackDataSections(SPARSE);
    // No prompt reached the client → the whole Prompts section disappears.
    expect(sections.map((s) => s.title)).toEqual(['Identity', 'Vibe', 'Provenance']);

    expect(sections[0]!.fields).toEqual([
      { label: 'Artist', value: 'Test Admin' },
      { label: 'Generated', value: 'Jul 22, 2026' },
    ]);
    // An instrumental Track still states its vocal mode — without a language.
    expect(sections[1]!.fields).toEqual([{ label: 'Vocals', value: 'Instrumental' }]);
    expect(sections[2]!.fields).toEqual([{ label: 'Provider', value: 'mock' }]);
  });

  it('shows the Generated day in the Instance timezone, not the UTC day', () => {
    // 00:30 on 4 November in Berlin is still 3 November in UTC.
    const identity = buildTrackDataSections({
      ...SPARSE,
      createdAt: '2026-11-03T23:30:00.000Z',
    })[0]!;
    expect(identity.fields).toContainEqual({ label: 'Generated', value: 'Nov 4, 2026' });
  });

  it('still shows a labelled date for Track Data kept offline without a timezone', () => {
    const { timezone: _absent, ...stored } = { ...SPARSE, createdAt: '2026-11-03T23:30:00.000Z' };
    const identity = buildTrackDataSections(stored)[0]!;
    expect(identity.fields).toContainEqual({ label: 'Generated', value: 'Nov 3, 2026 UTC' });
  });
});
